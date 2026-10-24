#!/bin/bash
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir dist && cp public/* dist/
npx esbuild src/main.tsx --bundle --minify --target=es2020 --jsx=automatic --jsx-import-source=preact --outfile=dist/app.js
V=$(sha1sum dist/app.js | cut -c1-10)
sed "s/__VERSION__/$V/" sw.template.js > dist/sw.js
printf '/sw.js\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n/\n  Cache-Control: no-cache\n/app.js\n  Cache-Control: no-cache\n' > dist/_headers
ls -la dist
