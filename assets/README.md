# iClaude graphics

The current mark is an original, AI-generated project symbol: an abstract cloud composed of five warm terracotta organic forms, with open spaces between them. It was generated with the built-in Codex imagegen tool on 2026-10-09 and inspected on light and dark backgrounds at 16, 32, 64 and 128 px. At 16 px the broad silhouette remains visible; the inner gaps are clearer from 32 px upward.

- `logo.png`: 1024 × 1024, transparent RGBA PNG master for general use.
- `source/icon-source.png`: the untouched 1254 × 1254 imagegen output.
- `manifest.json`: asset dimensions, modes, sizes, SHA-256 hashes, typography, exact copy and selection status.
- `icon.png`: 512 × 512, RGBA PNG with real alpha transparency. Used by both READMEs and copied unchanged into the Desktop Extension as `icon.png` (`manifest.json` already points to it). The package build verifies that the archived icon matches this file byte for byte.
- `social-preview.png`: 1280 × 640, opaque RGB PNG, under 1 MB. The same icon sits on a warm off-white background; English text was typeset separately so spelling and dimensions are exact. Upload this file in **Settings → General → Social preview → Edit → Upload an image**. Committing it alone does not change GitHub's social preview setting.

Exact social preview text:

```text
iClaude
iCloud for Claude Desktop
Calendar · Contacts · Mail
Reminders · Notes
Local MCP extension for macOS
Independent project · github.com/zoblon/iClaude
```

The preview uses Georgia Bold for the project name and Arial for supporting copy. These fonts are rasterized in the PNG; no font files are distributed. Background: `#FAF8F3`; text: `#342F28`, `#554C43`, `#766C60`. The icon uses warm terracotta and apricot tones.

## Provenance and trademarks

The earlier cloud graphic (introduced in commit `94e5ab6`) was based on Apple's iCloud logo and recolored in warm orange. It should not be credited as an original iClaude design. That graphic has been replaced in the current assets; older commits and previously published packages still contain it. The repository's MIT license does not grant rights to Apple or Anthropic trademarks or their official logos.

The replacement symbol was generated specifically for this independent project. Its cloud and warm organic forms refer to the connector's purpose; it does not incorporate the official Apple iCloud or Anthropic Claude mark. Current project graphics are distributed under the repository's [MIT license](../LICENSE). This is an asset provenance statement, not a claim of trademark registration or legal clearance.

iClaude is not affiliated with, endorsed by or sponsored by Apple or Anthropic. iCloud is a trademark of Apple Inc.; Claude is a trademark of Anthropic PBC.

## Generation prompt

Use case: logo-brand. Asset type: original iClaude app icon / repository mark, single transparent square PNG, 1024x1024 or larger. Create a distinctive cloud made from five to seven thick, organically curved terracotta fronds that fan upward and outward from an off-center lower junction, like a warm cloud unfurling. The collective outer silhouette must read clearly as a cloud with one taller central crown and two lower side lobes, a compact broad base. Each frond is an irregular chunky curved taper, broad at its round outer tip, with spacious clean transparent wedge-shaped gaps between some fronds. Combine the idea of cloud connectivity and warm radiating organic energy through your own original geometry. Aim for a restrained, sophisticated contemporary software mark; asymmetrical but balanced, exceptionally legible at 32px. Warm burnt terracotta #D97757, rust #B9553D and muted apricot #E8A181. Subtle tonal transitions may add dimension but predominantly bold solid color, crisp silhouette and smooth clean edges. No hairlines, tiny detached pieces, outlines, enclosing tile or cast shadows. Center full mark with generous transparent margins ~12% on every side. No text or letters. Must be independently designed: do not recreate Apple's iCloud silhouette with overlapping translucent circles, do not reproduce Anthropic's Claude starburst, do not use the OpenAI knot, do not make interlaced ribbon loops. No official brand logos. Real alpha transparency outside and between the forms, never painted checkerboard. The design is a single finished symbol, no variants, no sheet, no mockup.
