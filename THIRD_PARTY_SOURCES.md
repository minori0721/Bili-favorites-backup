# 对应源码与构建材料

本文件与 `Dockerfile`、`package-lock.json`、`docs/package-lock.json` 一起用于定位实际构建。许可证原文的副本保留原作者声明；本项目不声称拥有第三方代码。仅添加本文件不会原地修复已经发布的旧镜像和工具压缩包。

## BFB 与 biliAPI

- BFB 源码：[项目仓库](https://github.com/minori0721/Bili-favorites-backup)。镜像的 `BFB_BUILD_REVISION` 和版本窗口显示对应提交；在仓库打开该提交后，可下载其源码，内含 Dockerfile、锁文件和构建脚本。构建方式见 README。个人数据和凭据不属于对应源码。
- `@renmu/bili-api 2.14.0` 源码固定到标签 `2.14.0` 对应提交 [`c2dd2223e0d8df6774ebc6f025c33d7a0826b90d`](https://github.com/renmu123/biliAPI/tree/c2dd2223e0d8df6774ebc6f025c33d7a0826b90d)；[下载该提交源码](https://github.com/renmu123/biliAPI/archive/c2dd2223e0d8df6774ebc6f025c33d7a0826b90d.tar.gz)。原 TypeScript 源码、该库的构建命令及锁文件在此提交中；BFB 实际依赖版本及安全覆盖项见本项目锁文件。
- npm 生产依赖及其原始声明保留在镜像 `/app/node_modules/`，具体版本由锁文件确定。许可副本和源码链接不能替代 GPL 对完整、匹配、可获取的对应源码要求；依赖更新时须重新核对。

## BBDown

- 固定工具：[bfb-2.0.7](https://github.com/minori0721/BBDown/releases/tag/bfb-2.0.7)。对应源码提交 [`35a26fab051528532e126af7271dc1ca1be1746c`](https://github.com/minori0721/BBDown/tree/35a26fab051528532e126af7271dc1ca1be1746c)；[下载该提交源码](https://github.com/minori0721/BBDown/archive/35a26fab051528532e126af7271dc1ca1be1746c.tar.gz)。项目文件包含 NuGet 版本，`.github/workflows/bfb-release.yml` 记录 Native AOT 构建过程。
- 上游为 nilaoda/BBDown（MIT）；本仓库随附其版权原文。PlayerUnite 子集的来源标注为 `aaa1115910/bv`（MIT），也附带该项目许可。
- **待补齐**：旧 `BBDown_linux-x64.zip` 仅含可执行文件；本轮不覆盖它，也不改变 SHA256。后续工具包应带入主程序及实际编入的 .NET / NuGet 完整第三方声明，历史发布需另补配套材料。当前 BFB 新镜像先保留已核实的 BBDown、bv 许可，不能据此宣称旧 ZIP 或 Native AOT 的全部组件材料已经齐全。

## FFmpeg / ffprobe

- 固定资产：[ffmpeg-bfb-8.1.2-20260711.1](https://github.com/minori0721/Bili-favorites-backup/releases/tag/ffmpeg-bfb-8.1.2-20260711.1)。文件为 `ffmpeg-n8.1.2-22-g94138f6973-linux64-lgpl-8.1.tar.xz`，SHA256 为 `0102dad4a83b266f740a50db7cd5131a8e5266cde8f0937ec3f3cb4a8c3641fa`；未修改原压缩包。
- FFmpeg 本体对应提交 [`94138f6973dd1ac6208ace92148ac0d172455d65`](https://github.com/FFmpeg/FFmpeg/tree/94138f6973dd1ac6208ace92148ac0d172455d65)；[下载本体源码](https://github.com/FFmpeg/FFmpeg/archive/94138f6973dd1ac6208ace92148ac0d172455d65.tar.gz)。许可副本取自该提交的 `COPYING.LGPLv3`，并与 GPLv3 全文一起提供。
- 上游构建来自 BtbN/FFmpeg-Builds 的 `autobuild-2026-07-11-13-13`。核对时该自动 Release 已返回 404；不能将其当作仍然可靠的完整源码获取地址。
- **待补齐**：该非 shared 构建静态包含其他库。FFmpeg 本体源码链接不足以覆盖所有对应材料；还需准确追溯此构建的配方、补丁、第三方库版本及其源码和许可，再作为可长期取得的配套材料提供。本轮未取得这套完整材料，不声称已完成 FFmpeg 二进制的全部分发义务。

## 许可文本来源

| 本仓库文件 | 上游来源或实际随包位置 |
| --- | --- |
| `LICENSE` | `@renmu/bili-api 2.14.0/LICENSE` 的 GNU GPLv3 正文；原文未改 |
| `BBDown-MIT.txt` | `minori0721/BBDown` 固定源码提交的 LICENSE，原作者 nilaoda |
| `Artplayer-MIT.txt` | `zhw2590582/ArtPlayer` 的 LICENSE，Git blob `6777d120328d4b785bcf046706beecd4ba4364b6`；所用二进制另保留原版权头 |
| `bv-MIT.txt` | `aaa1115910/bv` 的 LICENSE，Git blob `6229b60e153f0a94e44a41bfd368a412082a1a01` |
| `FFmpeg-LGPL-3.0.txt` | FFmpeg 固定提交的 `COPYING.LGPLv3`，Git blob `65c5ca88a67c30becee01c5a8816d964b03862f9` |
| `Apache-2.0.txt` | `qrcode-terminal 0.12.0/LICENSE` 的 Apache-2.0 正文 |
| `Buf-Protobuf-BSD-3-Clause.txt` | `@bufbuild/protobuf 2.12.0/dist/esm/wire/varint.js` 中 Google 的完整 BSD 声明；Buf 的 Apache 声明仍在源文件中 |
| `nodable-entities-MIT.txt` | `nodable/val-parsers` 的 LICENSE，Git blob `561468f111a66df52cc0f1934642bb9fdd22a212` |
| `NotoSansSC-OFL.txt` | `google/fonts/ofl/notosanssc/OFL.txt`，Git blob `1c9f43281b8f216c5461fe9ac729afbade7724e4` |
| `Inter-OFL.txt` | `rsms/inter/LICENSE.txt`，Git blob `9b2ca37b3ffc77391d8b2ebef4a974ef32bf46ea` |

MIT 许可不以提供源码为分发条件，但仍须保留版权和许可声明。`byte-length 1.0.2` 的元数据声明 MIT，本次未在包或上游找到独立许可文本，未自行编造作者版权年份；该项原始声明仍需向上游核对。其他依赖若将完整许可写在 README、源文件头或 `LICENSE-MIT.txt` 中，这些文件同样保留，不能仅因缺少名为 LICENSE 的文件就判断为无许可。
