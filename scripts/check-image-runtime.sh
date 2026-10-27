#!/bin/sh
set -eu

for executable in /usr/local/bin/node /usr/bin/aria2c /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/BBDown; do
  test -x "$executable"
done

for tool in npm npx yarn yarnpkg corepack; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf 'Unexpected build tool in runtime image: %s\n' "$tool" >&2
    exit 1
  fi
done
if test -e /usr/local/lib/node_modules/npm; then
  printf 'Bundled npm dependencies remain in runtime image\n' >&2
  exit 1
fi

# Debian bookworm's fix for the reported OpenSSL advisory group.
# https://security-tracker.debian.org/tracker/CVE-2026-84782
minimum_openssl_version='3.0.22-1~deb12u2'
for package in libssl3 openssl; do
  version=$(dpkg-query -W -f='${Version}' "$package")
  if ! dpkg --compare-versions "$version" ge "$minimum_openssl_version"; then
    printf '%s %s is below the security floor %s\n' "$package" "$version" "$minimum_openssl_version" >&2
    exit 1
  fi
  printf 'Verified %s: %s\n' "$package" "$version"
done

aria2c --version >/dev/null
ffmpeg -version >/dev/null
ffprobe -version >/dev/null
BBDown --help >/dev/null
node -p 'JSON.stringify({node: process.version, undici: process.versions.undici, openssl: process.versions.openssl})'
