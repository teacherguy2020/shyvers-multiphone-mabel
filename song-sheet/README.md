# Shyvers Multiphone song-sheet publisher

This directory is a self-contained publishing system for the Shyvers
Multiphone insert. The blank PDFs are immutable artwork masters. The editable
Excel catalog supplies song data, and `tools/build.py` adds a deterministic
text-only overlay without redrawing or rewriting the artwork streams.

## Inputs and outputs

- `reference/blank_fullsize.pdf` — authoritative 14.75 × 6 inch master.
- `reference/blank_two_pages.pdf` — authoritative two-page US Letter master.
- `reference/version10_populated_two_pages.pdf` — approved typography and
  placement fixture; it is used for measured layout and embedded Sans Narrow
  font resources, never as the artwork source.
- `catalog/catalog.xlsx` — editable 170-selection catalog.
- `proof/song_sheet_fullsize.pdf` — generated one-page full-size proof.
- `proof/song_sheet_two_pages.pdf` — generated two-page printable proof.
- `proof/validation_report.json` — machine-readable validation results.

## Rebuild

From this directory:

```sh
python3 tools/collect_sources.py
python3 tools/build.py --refresh-catalog
```

After the source snapshot and catalog already exist, the routine proof build
(`python3 tools/build.py`) takes about **1.1 seconds** on the development Mac,
including PDF validation and 120-DPI proof rendering. The source-refresh step
adds the network/SSH time needed to read the live playlist and MPD metadata.

`collect_sources.py` performs read-only source capture: it reads the current
Multiphone playlist through the existing Track Key endpoint, reads MPD tags via
the existing SSH path, and measures the supplied Version 10 PDF. It does not
modify moOde, playback, Mabel, Sonuvi, or Pico firmware.

`build.py` uses Python's standard library plus the installed Poppler commands
`pdftotext`, `pdfinfo`, and `pdftoppm`. It writes the Excel workbook without a
third-party package so the build is reproducible on a clean Mac with those
tools installed.

## Catalog rules

The workbook preserves the original moOde selection number and source file for
each track. Songs may be regrouped in the printable categories, but selection
numbers remain 1–170 and are never renumbered. Printable titles/artists are
separate fields from the full MPD metadata.

Version 10's measured Sans Narrow title sizes are retained per slot. If a
future catalog edit is wider than its assigned slot, the build fails with an
overflow error; it does not silently shrink or truncate the text. The first
printable page contains panels 1–3 and the second contains panels 4–5. The
clipped, non-printing panel-4 extraction artifacts visible to PDF text
extractors in Version 10 are intentionally not added to page 1.

## Validation

The build checks:

- blank-master checksums and unchanged artwork PDF objects;
- exact 170-row catalog ordering and live moOde metadata cross-check;
- duplicate/missing selection numbers;
- title/artist overflow and page bounds;
- full-size and Letter page dimensions;
- presence of all catalog text;
- rendered PNG proofs beside the approved Version 10 renders.

The generated proof is intentionally a new PDF object graph with a text
overlay, so its PDF and PNG hashes are not expected to equal Version 10. The
validation report records the proof paths and leaves visual equivalence as an
explicit review item rather than silently declaring it.

The editability path was smoke-tested with a temporary workbook copy: one
printable title was changed, rebuilt, and compared against the baseline. Only
that title's tokens changed; the original `catalog.xlsx` was restored and its
SHA-256 remained identical. The approved blank masters and Version 10 fixture
are never modified by the build.
