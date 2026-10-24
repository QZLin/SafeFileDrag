#!/bin/sh
# Regenerate the extension icons from logo.svg.
#
# This lives in scripts/ instead of next to the icons on purpose: everything below
# icon/ is a packaging input, and web-ext lint would flag the .sh file extension in it.

set -eu
cd "$(dirname "$0")/../icon"

src=logo.svg

for size in 16 20 25 30 32 48 96 128 256; do
    magick -background none "$src" -resize "${size}x${size}" "logo_${size}.png"
done