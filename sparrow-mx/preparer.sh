#!/usr/bin/env bash
# Reconstruit les sources du moteur sparrow-mx dans le dossier « build/ » :
#   Sparrow 0.2.0 (commit fixe) + jagua-rs 0.8.1 (empreinte vérifiée) + nos correctifs.
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
SPARROW_COMMIT=9ef45676695ef94d045ac8bff0530822127f1437
JAGUA_SHA256=9d7caee14697389b200dcae02809a50e301ccc3316dbd7b732e77d50923d46c4
rm -rf "$ICI/build" && mkdir -p "$ICI/build" && cd "$ICI/build"
git init -q . && git remote add origin https://github.com/JeroenGar/sparrow.git
git fetch -q --depth 1 origin "$SPARROW_COMMIT" && git checkout -q FETCH_HEAD
git apply "$ICI/sparrow-mx.diff"
curl -sSfL https://static.crates.io/crates/jagua-rs/jagua-rs-0.8.1.crate -o jagua.crate
echo "$JAGUA_SHA256  jagua.crate" | sha256sum -c -
tar xzf jagua.crate && mv jagua-rs-0.8.1 jagua-rs && rm jagua.crate jagua-rs/Cargo.lock
( cd jagua-rs && git apply -p1 "$ICI/jagua-rs-0.8.1-mx.diff" )
cp "$ICI/Cargo.lock" Cargo.lock
echo "Sources prêtes dans $ICI/build"
