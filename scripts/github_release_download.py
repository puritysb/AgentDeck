#!/usr/bin/env python3
"""Download the same public GitHub release asset through its official API.

CI-only transport recovery: no mirrors, version substitution or unverified bytes.
The optional Python HTTP hooks activate only in the isolated inventory job.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import quote, unquote, urlsplit

OPEN = urllib.request.urlopen
TRANSIENT = {502, 503, 504}
MAX_BYTES = 2 * 1024 ** 3
# Before GitHub supplied asset digests: the zip's 13 ELF payloads match the
# existing installation byte for byte; its reviewed tools.json pins the tar.
# Keep identity + size + hash together, and never learn new pins at runtime.
LEGACY_ASSETS = {
    'https://github.com/pioarduino/registry/releases/download/0.0.1/esp-rom-elfs-20241011.zip':
        (251315460, 3535051, '8f1f9041a44390650994499c95dd20851222a4bdaa162dd68f6cef5af3e39501'),
    'https://github.com/espressif/esp-rom-elfs/releases/download/20241011/esp-rom-elfs-20241011.tar.gz':
        (198395584, 3540038, '921f000164a421c7628fbfee55b173384aafaa51883adc65cd27bf9b0af9e9a9'),
}


def release_identity(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'github.com' or parsed.query or parsed.fragment:
        raise ValueError('Expected an exact public github.com release asset URL')
    match = re.fullmatch(r'/([\w.-]+)/([\w.-]+)/releases/download/([^/]+)/([^/]+)', parsed.path)
    if not match:
        raise ValueError('Expected a GitHub release download path')
    owner, repo, tag, name = match.groups()
    return owner, repo, unquote(tag), unquote(name)


def gradle_release(properties):
    urls = [line.split('=', 1)[1].replace('\\:', ':') for line in properties.splitlines()
            if line.startswith('distributionUrl=')]
    match = re.fullmatch(r'https://services\.gradle\.org/distributions/gradle-([0-9]+(?:\.[0-9]+){1,2})-bin\.zip', urls[0]) if len(urls) == 1 else None
    if not match:
        raise ValueError('Expected one stable Gradle wrapper distribution URL')
    version = match.group(1)
    return version, f'https://github.com/gradle/gradle-distributions/releases/download/v{version}/gradle-{version}-bin.zip'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def asset_metadata(url):
    owner, repo, tag, name = release_identity(url)
    api = f'https://api.github.com/repos/{owner}/{repo}/releases/tags/{quote(tag, safe="")}'
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'AgentDeck-CI'}
    # A credential is confined to the non-redirecting api.github.com metadata
    # request. Asset redirects never receive it.
    token = os.environ.get('GITHUB_TOKEN')
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(api, headers=headers), timeout=60) as response:
        if response.status != 200:
            raise ValueError('Unexpected GitHub metadata status')
        raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError('Oversized GitHub release metadata')
        release = json.loads(raw)
    assets = [a for a in release['assets'] if a['name'] == name and a['browser_download_url'] == url]
    if len(assets) != 1:
        raise ValueError('Exact release asset is missing or ambiguous')
    asset = assets[0]
    if type(asset['id']) is not int or type(asset['size']) is not int or not 0 < asset['size'] <= MAX_BYTES:
        raise ValueError('Invalid release asset identity or size')
    if url in LEGACY_ASSETS:
        identity, size, sha = LEGACY_ASSETS[url]
        if (asset['id'], asset['size']) != (identity, size) or asset.get('digest') not in (None, 'sha256:' + sha):
            raise ValueError('Reviewed legacy asset identity changed')
        asset = {**asset, 'digest': 'sha256:' + sha}
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest') or ''):
        raise ValueError('GitHub asset has no SHA-256 digest; refusing fallback')
    return owner, repo, asset


def verified_asset(url):
    owner, repo, asset = asset_metadata(url)
    api = f'https://api.github.com/repos/{owner}/{repo}/releases/assets/{asset["id"]}'
    request = urllib.request.Request(api, headers={'Accept': 'application/octet-stream', 'User-Agent': 'AgentDeck-CI'})
    stream = tempfile.TemporaryFile()
    try:
        total, digest, started = 0, hashlib.sha256(), time.monotonic()
        # Deliberately no Authorization header on this redirecting request.
        with OPEN(request, timeout=60) as response:
            if response.status != 200:
                raise ValueError('Expected a complete release asset response')
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > asset['size'] or time.monotonic() - started > 600:
                    raise ValueError('Asset size or transfer time limit exceeded')
                digest.update(chunk)
                stream.write(chunk)
        if total != asset['size'] or 'sha256:' + digest.hexdigest() != asset['digest']:
            raise ValueError('Release asset size or SHA-256 mismatch')
        stream.seek(0)
        print(f'[github-asset] API verified {asset["name"]}: {total} bytes, {asset["digest"]}', flush=True)
        return stream, total
    except BaseException:
        stream.close()
        raise


def asset_get(method, url):
    if method.upper() != 'GET':
        return False
    try:
        release_identity(url)
        return True
    except ValueError:
        return False


def eligible(method, url, status):
    return status in TRANSIENT and asset_get(method, url)


def install_fallback():
    """Preserve callers' URLs/checksums; replace only failed asset transport."""
    import email.message
    import urllib.response

    def urlopen(request, *args, **kwargs):
        url = request.full_url if isinstance(request, urllib.request.Request) else request
        method = request.get_method() if isinstance(request, urllib.request.Request) else 'GET'
        try:
            return OPEN(request, *args, **kwargs)
        except urllib.error.HTTPError as error:
            if not eligible(method, url, error.code):
                raise
            error.close()
        except (TimeoutError, ConnectionError):
            if not asset_get(method, url):
                raise
        except urllib.error.URLError as error:
            if not asset_get(method, url) or not isinstance(error.reason, (TimeoutError, ConnectionError)):
                raise
        stream, size = verified_asset(url)
        headers = email.message.Message()
        headers['Content-Length'] = str(size)
        return urllib.response.addinfourl(stream, headers, url, 200)

    urllib.request.urlopen = urlopen
    try:
        import requests
    except ImportError:
        return  # Minimal child venvs use urllib; do not install dependencies.
    original = requests.Session.request

    def request(self, method, url, *args, **kwargs):
        if kwargs.get('timeout') is None:
            kwargs['timeout'] = (10, 60)
        elif isinstance(kwargs['timeout'], tuple) and kwargs['timeout'][1] is None:
            kwargs['timeout'] = (kwargs['timeout'][0], 60)
        try:
            response = original(self, method, url, *args, **kwargs)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as error:
            if isinstance(error, requests.exceptions.SSLError) or not asset_get(method, url):
                raise
            source_request = error.request
        else:
            if not eligible(method, url, response.status_code):
                return response
            source_request = response.request
            response.close()
        stream, size = verified_asset(url)
        result = requests.Response()
        result.status_code, result.url, result.request = 200, url, source_request
        result.headers['Content-Length'] = str(size)
        result.raw = stream
        if not kwargs.get('stream'):
            result.content
            stream.close()
        return result

    requests.Session.request = request


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    stream, _ = verified_asset(args.url)
    try:
        with args.output.open('wb') as output:
            shutil.copyfileobj(stream, output)
    finally:
        stream.close()
