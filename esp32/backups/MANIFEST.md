# Vendor firmware backups

Factory images for boards AgentDeck does not build firmware for, kept so a unit can be
restored to its shipped state after experimentation.

`esp32/.gitignore` ignores `*.bin`, so the binaries themselves are **not** committed. This
manifest is the tracked provenance record — re-download from the listed source and verify the
SHA-256 to reproduce the directory.

## Ulanzi TC001

| File | Size | Notes |
|---|---:|---|
| `ulanzi-tc001-factory-8MB.bin` | 8 MB | Stock Ulanzi image captured before the AgentDeck `led8x32` firmware was first flashed. |

SHA-256 `25998ea66d8b393b358f5e267c47a7ea18348c3c58047f1309de5e7544639083`

## LilyGO T-Display-S3-Pro V1.1

Captured directly from the on-hand unit (no camera fitted) over native USB on
2026-07-25, before any AgentDeck experimentation — this is the unit's shipped
state and its rollback target. Read in 256 KiB chunks (single large
`read_flash` calls corrupted intermittently on this unit's USB CDC);
spot-verified against fresh re-reads at 0x300000 and 0xC80000.

| File | Layout | Size |
|---|---|---:|
| `t-display-s3-pro-factory-16MB.bin` | Merged full-flash → `0x0` | 16,777,216 B |

SHA-256 `9f6765e5e619627228a5e4dad0f1910b74f850d61960586add91a5e11ded66e1`

The second on-hand unit (GC0308 camera fitted) was captured the same way on
2026-07-27, before its first AgentDeck flash. Its factory image differs from
the no-camera unit's (camera demo firmware). Two capture gotchas from this
unit: 460800 baud reads die mid-stream on this CDC (230400 is the reliable
rate, same as uploads), and the **daemon must be stopped during capture** —
its periodic probe of unidentified serial ports opens the port mid-read
(pySerial "multiple access on port"). Spot-verified at 0x0, 0x300000,
0xA00000, 0xC80000.

| File | Layout | Size |
|---|---|---:|
| `t-display-s3-pro-camera-factory-16MB.bin` | Merged full-flash → `0x0` | 16,777,216 B |

SHA-256 `57c9bd88043af637cb8a7e35d571a4b8704b83bcfd19a42d5a291a7ea790ebab`

Restore either unit with:

```bash
esptool --port <port> write-flash 0x0 esp32/backups/<file>
```

## LilyGO T-Embed CC1101

Source: [`Xinyuan-LilyGO/T-Embed-CC1101`](https://github.com/Xinyuan-LilyGO/T-Embed-CC1101) `firmware/`

| File | Upstream name | Layout | Size |
|---|---|---|---:|
| `t-embed-cc1101-factory-newui-SW1.0.0-20260625-app.bin` | `T_Embed_CC1101_HW_V1.0_SW_V1.0.0.bin` | App image → flash at `0x10000` | 1,140,112 B |
| `t-embed-cc1101-factory-blackscreenfix-20260605-16MB.bin` | `T_Embed_CC1101_black_screen_fix_20260605.bin` | Merged full-flash → `0x0` | 16,711,680 B |
| `t-embed-cc1101-factory-v1.6-20260527-16MB.bin` | `T_Embed_CC1101_v1.6_20260527.bin` | Merged full-flash → `0x0` | 16,711,680 B |
| `t-embed-cc1101-factory-K230-v1.2-20250214-16MB.bin` | `K230_factory_v1.2_20250214.bin` | Merged full-flash → `0x0` | 16,711,680 B |

```
e7a00ad05e6228d1508c82c79993c2bde25c6be415df611a4b7cae66c119c050  t-embed-cc1101-factory-newui-SW1.0.0-20260625-app.bin
0a47906160b57c2eb87789d7306a488c4218f3edb9159261d836291a68726996  t-embed-cc1101-factory-blackscreenfix-20260605-16MB.bin
222e64fe2078f904bf13bef8dd843de92559092cb58eac58d13dd761f7d1bcbf  t-embed-cc1101-factory-v1.6-20260527-16MB.bin
d3f41358ca5f9e4415000788506d8decdee5cce781014747143fa385d1ec10fe  t-embed-cc1101-factory-K230-v1.2-20250214-16MB.bin
```

Which one is which:

- **`newui-SW1.0.0-20260625`** is the newest upstream build (commit *"[Version]：V1.0.0 — Add a new UI factory program"*, 2026-06-25). Version numbering restarted at 1.0.0 for the rewritten factory UI, so it is **not** older than `v1.6`. It is an app-only image; flash it at `0x10000` over an existing partition table.
- **`blackscreenfix-20260605`** addresses the upstream "screen does not light up after flashing" issue. Try this before assuming a hardware fault; the vendor's own remedy is to press `RST` on the back after flashing.
- **`v1.6-20260527`** is the last build of the previous UI lineage.
- **`K230-v1.2-20250214`** is the image **the on-hand unit shipped with** — verified byte-identical to the device's flash at `0x10000` (256 KiB) and `0x180000` (32 KiB). This is the rollback target. `K230` is only a build-directory label from the vendor's machine (`D:/dgx/code/[K230] T_Embed_CC1101/…`), not a hardware variant or a camera module.

Restore the shipped state with:

```bash
esptool --port <port> write-flash 0x0 esp32/backups/t-embed-cc1101-factory-K230-v1.2-20250214-16MB.bin
```

See [Hardware and OS Compatibility](../../docs/hardware-compatibility.md) for the board specifications.
