"""Opt-in transport fallback, confined to the isolated firmware inventory job."""
import os
from pathlib import Path
import sys

if os.environ.get('AGENTDECK_GITHUB_ASSET_FALLBACK') == '1':
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from github_release_download import install_fallback
    install_fallback()
