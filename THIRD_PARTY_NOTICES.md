# 第三方版权与许可

Bili-favorites-backup 自有代码按 **GPL-3.0-only** 发行。完整条款见 [LICENSE](LICENSE)。允许使用、修改和商业分发；分发受 GPL 覆盖的版本时须遵守许可与对应源码义务。软件按现状提供，不作担保。第三方组件的原有版权与许可不因本项目声明而改变。

本页记录当前锁定依赖和工具的许可来源，不是“全部历史发布物已完成合规”的保证。固定源码获取方法及尚未补齐的材料见[对应源码与构建材料](THIRD_PARTY_SOURCES.md)。后续改变依赖或工具版本时，应同步核对本页与许可原文。

## 应用运行依赖

版本以 `package-lock.json` 为准。镜像保留 `/app/node_modules/` 内的软件及其原始 LICENSE、COPYING、NOTICE、README 和源文件声明，不应在精简镜像时删除它们。

| 组件 | 本次核对版本 | 许可证 | 来源 |
| --- | --- | --- | --- |
| @renmu/bili-api | 2.14.0 | GPLv3，包内附第 3 版全文 | [biliAPI](https://github.com/renmu123/biliAPI/tree/2.14.0)；[本项目随附 GPL 全文](LICENSE) |
| archiver | 8.0.0 | MIT | [node-archiver](https://github.com/archiverjs/node-archiver) |
| artplayer | 5.4.0 | MIT | [ArtPlayer](https://github.com/zhw2590582/ArtPlayer)；[许可原文](licenses/Artplayer-MIT.txt)；所用脚本还保留其版本、Harvey Zhao 的版权头及 MIT 标记 |
| better-sqlite3 | 12.11.1 | MIT | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)；内置 SQLite 的来源声明由该包保留 |
| driver.js | 1.10.2 | MIT | [Driver.js](https://github.com/nilbuild/driver.js)；[许可原文](licenses/Driverjs-MIT.txt) |
| express | 4.22.2 | MIT | [Express](https://github.com/expressjs/express) |
| express-rate-limit | 8.5.2 | MIT | [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) |
| express-session | 1.19.0 | MIT | [express-session](https://github.com/expressjs/session) |
| markdown-it | 15.0.1 | MIT | [markdown-it](https://github.com/markdown-it/markdown-it) |
| qrcode | 1.5.4 | MIT | [node-qrcode](https://github.com/soldair/node-qrcode) |
| qrcode-terminal | 0.12.0 | Apache-2.0 | [qrcode-terminal](https://github.com/gtanner/qrcode-terminal)；[许可全文](licenses/Apache-2.0.txt) |
| webdav | 5.10.0 | MIT | [webdav-client](https://github.com/perry-mitchell/webdav-client) |
| yauzl | 3.4.0 | MIT | [yauzl](https://github.com/thejoshwolfe/yauzl) |

传递依赖仍各自适用原许可，其中 `@renmu/throttle 1.0.3` 的包内 LICENSE 明确为 Nathan Rajlich 的 MIT 许可；`@bufbuild/protobuf 2.12.0` 声明 Apache-2.0 AND BSD-3-Clause，源文件保留 Buf Technologies 与 Google 的声明，并在此补附 [Apache 全文](licenses/Apache-2.0.txt)及 [Google BSD 声明](licenses/Buf-Protobuf-BSD-3-Clause.txt)。`@nodable/entities 2.1.0` 的 [MIT 原文](licenses/nodable-entities-MIT.txt)亦随附。其他 MIT、ISC、BSD、PSF 等原始材料随各依赖目录保留。

## 镜像内的独立工具

- **BBDown bfb-2.0.7**：MIT，Copyright (c) 2020 nilaoda。使用 [BFB fork](https://github.com/minori0721/BBDown)，原作者见 [上游](https://github.com/nilaoda/BBDown)；[许可全文](licenses/BBDown-MIT.txt)。fork 中最小 PlayerUnite 协议定义标注源自 `aaa1115910/bv`，该项目的 [MIT 版权与许可](licenses/bv-MIT.txt)一并保留。BBDown 的 NuGet 和 .NET Native AOT 组件仍适用各自许可，完整随包清单的待办见来源说明。
- **FFmpeg / ffprobe**：当前固定 `n8.1.2-22-g94138f6973-20260711` 的 `linux64-lgpl-8.1` 构建。线上 `ffmpeg -L` 报告 **LGPL 第 3 版或更高版本**；随附 [LGPLv3 全文](licenses/FFmpeg-LGPL-3.0.txt)，其中引用的 GPLv3 全文见 [LICENSE](LICENSE)。静态链接的第三方库保留各自权利；FFmpeg 的 LGPL 不能代替这些组件的许可与源码材料。
- **aria2**：镜像通过 Debian 软件包安装，保留 `/usr/share/doc/aria2/copyright`、`/usr/share/common-licenses/` 等原始材料；该包声明 GPL-2.0-or-later，并有 OpenSSL 例外说明。其依赖与包版本以实际镜像的 dpkg 记录为准。
- **Node.js、tini 与 Debian 系统组件**：各自保留原许可；Node 的版权材料位于 `/usr/local/LICENSE`，tini 等 Debian 包位于 `/usr/share/doc/<包名>/copyright`。本项目许可不重新授权这些独立组件。

## 浏览器、文档与字体

- 浏览器播放器 Artplayer 的原始版权头保留，完整 MIT 文本同时随镜像与仓库提供。
- 界面引导 Driver.js 随前端本地打包，完整 MIT 文本随镜像与仓库提供。
- 应用通过 Google Fonts 加载 **Noto Sans SC**，未在应用镜像中另行打包字体二进制；其 [SIL OFL 1.1 原文及保留字体名称](licenses/NotoSansSC-OFL.txt)随附。
- 文档站使用 **VitePress 1.6.4 / Vue 3.5.42（MIT）**，以及 VitePress 随附的 **Inter（SIL OFL 1.1）**。作者声明与许可全文随静态站点的 [licenses.txt](docs/public/licenses.txt) 提供；[Inter 原许可](licenses/Inter-OFL.txt)亦保留在仓库。文档构建依赖的具体版本见 `docs/package-lock.json`。

## 外部服务及参考资料

- AList / OpenList 作为独立服务，通过 WebDAV 与 BFB 通信；采用它们自己的许可。Compose 中独立拉取的 AList 镜像不被重新授权为 BFB 的代码。
- Bili23 的源码采用 GPLv3；API Collect 文档声明 CC BY-NC 4.0。接口资料与实现参考不等同于复制许可；复制或改编其受保护源码、文档表达时，应保留相应权利声明并单独核对许可。本页不作逐行代码来源鉴定。
- 软件许可证不授予视频、封面、账号或商标的其他权利。
