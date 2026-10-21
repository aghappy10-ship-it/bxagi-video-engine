# BXAGI Showcase SC Subset

This directory documents the licensed font input bundled by `server/bxagi-showcase-font.mjs` for the fixed `showcase-v1` production brief in `server/bxagi-showcase.mjs`. The font binary is embedded in that module and is not a finished creative.

`showcaseFontResources()` returns the font, unchanged `OFL.txt`, and `NOTICE.txt` as three Blob resources with filenames, byte sizes and SHA-256 checksums. Preserve the license and notice alongside the task inputs. Input storage can give the font a `.bin` extension; its contents remain a valid TrueType font that Pillow can load by path.

The source is Noto Sans SC from the official Google Fonts repository. The modified family is **BXAGI Showcase SC Subset**, instantiated at static weight **600** and renamed. `CHARACTERS.txt` contains the exact supported character set: all fixed showcase screen copy and printable ASCII. It is a limited subset, not a general-purpose Chinese font. New screen copy requires a coverage check and, when necessary, a rebuilt subset.

`source-record.json` records the original and subset hashes, upstream source URL, license, glyph coverage, variable-axis removal, names and Pillow loading checks. The build validated every supported non-whitespace character has an outline. The source font's copyright and the complete SIL Open Font License 1.1 are retained.

Only input font resources are created here. The BXAGI employee must render and validate the actual video, cover and production notes.
