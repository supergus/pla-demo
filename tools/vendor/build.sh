#!/usr/bin/env bash
# Rebuild the vendored browser libraries in public/vendor (run from tools/vendor: npm ci && ./build.sh).
set -euo pipefail
cd "$(dirname "$0")"
OUT=../../public/vendor
mkdir -p $OUT/oxigraph
npx esbuild entry-shacl.mjs --bundle --format=esm --minify --platform=browser --target=es2020 --outfile=$OUT/rdf-shacl.js --legal-comments=eof
cp node_modules/oxigraph/web.js node_modules/oxigraph/web_bg.wasm $OUT/oxigraph/
cp node_modules/vis-network/standalone/umd/vis-network.min.js $OUT/
for p in n3 shacl-engine rdf-ext oxigraph vis-network; do echo "$p $(node -p "require('./node_modules/$p/package.json').version") $(node -p "require('./node_modules/$p/package.json').license")"; done > $OUT/VERSIONS.txt
cat $OUT/VERSIONS.txt
