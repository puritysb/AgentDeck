#!/usr/bin/env python3
"""Build an offline scenario bundle using canonical design assets, no network."""
from pathlib import Path
import argparse
import shutil

source = Path(__file__).resolve().parent
root = source.parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('destination', type=Path)
args = parser.parse_args()
output = args.destination.resolve()
if output.exists():
    raise SystemExit('Destination already exists; choose a new output folder.')
output.mkdir(parents=True)
assets = output / 'assets'
assets.mkdir()
for name in ('index.html', 'style.css', 'journey.js'):
    text = (source / name).read_text()
    text = text.replace('../../design/tokens.css', 'assets/tokens.css')
    text = text.replace('../../design/fonts/', 'assets/')
    text = text.replace('../../design/brand/', 'assets/')
    (output / name).write_text(text)
for name in ('tokens.css', 'fonts/IBMPlexSansKR-Regular.ttf', 'fonts/IBMPlexSansKR-Bold.ttf', 'brand/agentdeck-icon.png'):
    shutil.copy2(root / 'design' / name, assets / Path(name).name)
shutil.make_archive(str(output), 'zip', output)
print(output / 'index.html')
print(str(output) + '.zip')
