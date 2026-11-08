"""Offline transport/integrity regressions; no real token or network request."""
import hashlib
import io
import json
from pathlib import Path
import sys
import types
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import github_release_download as download

URL = 'https://github.com/example/tool/releases/download/v1/tool.zip'
BODY = b'synthetic archive bytes'
ASSET = {'id': 123, 'name': 'tool.zip', 'browser_download_url': URL,
         'size': len(BODY), 'digest': 'sha256:' + hashlib.sha256(BODY).hexdigest()}


class Response(io.BytesIO):
    status = 200


class DownloadTests(unittest.TestCase):
    def test_gradle_api_version_follows_committed_wrapper(self):
        for version in ['8.14.5', '9.2']:
            original = 'distributionUrl=https\\://services.gradle.org/distributions/gradle-' + version + '-bin.zip\n'
            selected, url = download.gradle_release(original)
            self.assertEqual(selected, version)
            self.assertEqual(url, f'https://github.com/gradle/gradle-distributions/releases/download/v{version}/gradle-{version}-bin.zip')
        for original in ['', 'distributionUrl=https://other.test/gradle-8.14.5-bin.zip',
                         'distributionUrl=https://services.gradle.org/distributions/gradle-8.14.5-bin.zip\ndistributionUrl=other']:
            with self.assertRaises(ValueError):
                download.gradle_release(original)

    def test_exact_origin_and_path_only(self):
        self.assertEqual(download.release_identity(URL), ('example', 'tool', 'v1', 'tool.zip'))
        for url in [URL.replace('https:', 'http:'), URL.replace('github.com', 'github.com.evil'),
                    URL.replace('github.com', 'user@github.com'), URL + '?token=fake', URL + '#part',
                    URL.replace('/releases/download/', '/raw/')]:
            with self.assertRaises(ValueError):
                download.release_identity(url)
        self.assertTrue(download.eligible('GET', URL, 504))
        for method, status in [('POST', 504), ('GET', 401), ('GET', 404), ('GET', 200)]:
            self.assertFalse(download.eligible(method, URL, status))

    def test_metadata_binds_exact_name_url_digest_and_size(self):
        def metadata(asset):
            opener = types.SimpleNamespace(open=lambda *a, **k: Response(json.dumps({'assets': [asset]}).encode()))
            with patch.object(urllib.request, 'build_opener', return_value=opener):
                return download.asset_metadata(URL)
        self.assertEqual(metadata(ASSET)[2], ASSET)
        for changed in [{'digest': None}, {'digest': 'md5:123'}, {'size': True}, {'size': 0},
                        {'size': download.MAX_BYTES + 1}, {'id': '123'}, {'browser_download_url': URL + '.evil'}]:
            with self.assertRaises(ValueError):
                metadata({**ASSET, **changed})

    def test_full_bytes_verified_and_asset_request_has_no_credential(self):
        def open_asset(request, **kwargs):
            self.assertEqual(request.full_url, 'https://api.github.com/repos/example/tool/releases/assets/123')
            self.assertIsNone(request.get_header('Authorization'))
            self.assertEqual(kwargs['timeout'], 60)
            return Response(BODY)
        with patch.object(download, 'asset_metadata', return_value=('example', 'tool', ASSET)), \
             patch.object(download, 'OPEN', side_effect=open_asset), \
             patch.dict('os.environ', {'GITHUB_TOKEN': 'synthetic-not-a-real-token'}):
            stream, size = download.verified_asset(URL)
            with stream:
                self.assertEqual(stream.read(), BODY)
                self.assertEqual(size, len(BODY))

    def test_legacy_exception_requires_reviewed_id_size_and_hash(self):
        def metadata(asset):
            opener = types.SimpleNamespace(open=lambda *a, **k: Response(json.dumps({'assets': [asset]}).encode()))
            with patch.object(urllib.request, 'build_opener', return_value=opener):
                return download.asset_metadata(URL)[2]
        pin = (ASSET['id'], ASSET['size'], ASSET['digest'].split(':')[1])
        with patch.dict(download.LEGACY_ASSETS, {URL: pin}):
            self.assertEqual(metadata({**ASSET, 'digest': None})['digest'], ASSET['digest'])
            for changed in [{'id': 124}, {'size': ASSET['size'] + 1}, {'digest': 'sha256:' + '0' * 64}]:
                with self.assertRaisesRegex(ValueError, 'identity changed'):
                    metadata({**ASSET, **changed})

    def test_truncation_corruption_oversize_and_partial_response_refused(self):
        for body, status in [(BODY[:-1], 200), (BODY.replace(b'bytes', b'wrong'), 200),
                             (BODY + b'extra', 200), (BODY, 206)]:
            response = Response(body)
            response.status = status
            with patch.object(download, 'asset_metadata', return_value=('example', 'tool', ASSET)), \
                 patch.object(download, 'OPEN', return_value=response):
                with self.assertRaises(ValueError):
                    download.verified_asset(URL)

    def test_metadata_token_is_confined_to_nonredirecting_api_request(self):
        def open_metadata(request, **kwargs):
            self.assertEqual(request.get_header('Authorization'), 'Bearer synthetic-token')
            self.assertTrue(request.full_url.startswith('https://api.github.com/repos/example/tool/'))
            return Response(json.dumps({'assets': [ASSET]}).encode())
        with patch.dict('os.environ', {'GITHUB_TOKEN': 'synthetic-token'}), \
             patch.object(urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=open_metadata)) as builder:
            download.asset_metadata(URL)
            self.assertIsInstance(builder.call_args.args[0], download.NoRedirect)
        self.assertIsNone(download.NoRedirect().redirect_request(None, None, 302, None, None, 'https://other.test'))

    def test_urllib_falls_back_only_for_transient_exact_asset_get(self):
        def original(request, *args, **kwargs):
            url = request.full_url if isinstance(request, urllib.request.Request) else request
            raise urllib.error.HTTPError(url, 504, 'synthetic unavailable', {}, io.BytesIO(b'unavailable'))
        before = urllib.request.urlopen
        try:
            with patch.object(download, 'OPEN', side_effect=original), \
                 patch.dict(sys.modules, {'requests': None}), \
                 patch.object(download, 'verified_asset', return_value=(io.BytesIO(BODY), len(BODY))) as verified:
                download.install_fallback()
                with urllib.request.urlopen(URL) as response:
                    self.assertEqual(response.read(), BODY)
                    self.assertEqual(response.code, 200)
                for request in ['https://other.test/file.zip', urllib.request.Request(URL, data=b'POST')]:
                    with self.assertRaises(urllib.error.HTTPError):
                        urllib.request.urlopen(request)
                verified.assert_called_once_with(URL)
        finally:
            urllib.request.urlopen = before

    def test_requests_stream_keeps_original_identity(self):
        failed = types.SimpleNamespace(status_code=504, request='original-request', close=lambda: None)
        class Session:
            def request(self, *args, **kwargs):
                return failed
        class Result:
            def __init__(self):
                self.headers = {}
        before = urllib.request.urlopen
        try:
            with patch.dict(sys.modules, {'requests': types.SimpleNamespace(Session=Session, Response=Result)}), \
                 patch.object(download, 'verified_asset', return_value=(io.BytesIO(BODY), len(BODY))):
                download.install_fallback()
                result = Session().request('GET', URL, stream=True)
                with result.raw:
                    self.assertEqual(result.raw.read(), BODY)
                self.assertEqual((result.status_code, result.url, result.request), (200, URL, 'original-request'))
                self.assertEqual(result.headers['Content-Length'], str(len(BODY)))
                self.assertIs(Session().request('GET', 'https://other.test/file', stream=True), failed)
        finally:
            urllib.request.urlopen = before


if __name__ == '__main__':
    unittest.main()
