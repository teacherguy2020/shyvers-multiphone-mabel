#!/bin/bash

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_SCRIPT="$SCRIPT_DIR/tools/build.py"
OUTPUT_PDF="$SCRIPT_DIR/proof/song_sheet_two_pages.pdf"

printf '%s\n' 'Building the Shyvers Multiphone insert...'
printf '  Directory: %s\n' "$SCRIPT_DIR"

if [[ ! -f "$BUILD_SCRIPT" ]]; then
    printf 'ERROR: build script not found: %s\n' "$BUILD_SCRIPT" >&2
    exit 1
fi

if ! PYTHON_BIN="$(command -v python3)"; then
    printf '%s\n' 'ERROR: python3 was not found on PATH.' >&2
    exit 1
fi

if ! "$PYTHON_BIN" "$BUILD_SCRIPT"; then
    printf '%s\n' 'ERROR: the song-sheet build failed. Review the output above.' >&2
    exit 1
fi

if [[ ! -f "$OUTPUT_PDF" ]]; then
    printf 'ERROR: build completed without creating: %s\n' "$OUTPUT_PDF" >&2
    exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
    printf '%s\n' 'ERROR: this launcher is intended for macOS (Preview is unavailable here).' >&2
    printf 'Generated PDF: %s\n' "$OUTPUT_PDF"
    exit 1
fi

if ! open -a 'Preview' "$OUTPUT_PDF"; then
    printf 'ERROR: the PDF was generated, but Preview could not open it: %s\n' "$OUTPUT_PDF" >&2
    exit 1
fi

printf '%s\n' 'SUCCESS: validation passed and the printable PDF is open in Preview.'
printf 'Generated PDF: %s\n' "$OUTPUT_PDF"
