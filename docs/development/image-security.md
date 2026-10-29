# 镜像安全核验与告警处置

## 范围与结果口径

2026-10-28 从 Docker Hub/Scout 完整读取 `a95b7b5` 的 68 条告警，23 组源码包，共 13 高危、4 中危、51 低危，无严重告警。

- 索引摘要：`sha256:1fdbeefbcabf025a5650a3add242403af77235b06df7e261deae447a8f84a312`。
- Linux/amd64 清单：`sha256:e891208564054214c997e6df183e071db31558f65e7e599a91521a5dcf8cb515`。
- 以下是该固定镜像的调查基线，不是后续镜像的扫描结果。漏洞库可能更新。
- **源码已补丁**、**镜像已修复**、**组件移除**、**已缓解**、**确认不适用**、**未解决**分别记录。限制触发条件不等于修复原组件；缺少实际文件或运行证据时保留未解决状态。
- 本记录不配置 Scout 例外，不用台账豁免发布检查。新镜像未完成隔离验收与重扫时，不能声明告警已消失。

## 应用依赖补丁

| 依赖 | 基线 → 源码锁定版本 | 基线 CVE | 处理与验证 |
| --- | --- | --- | --- |
| body-parser | 1.20.6 → 1.20.9 | CVE-2026-111181（高） | 更新现有 override；用真正的登录中间件验证 JSON/表单、gzip/deflate、大小限制及迟到解压错误，子进程隔离崩溃。 |
| follow-redirects | 1.16.0 → 1.16.1 | CVE-2026-111755、CVE-2026-111756（高） | 锁定补丁；真实本地重定向验证数组请求头、自定义特殊字符请求头和 B站 API 使用的 Axios 依赖，不发送真实凭据。 |
| markdown-it | 15.0.1 → 15.0.3 | CVE-2026-111758、CVE-2026-111759（高）；CVE-2026-111766（低） | 维持 html/linkify/typographer 关闭及 24,000 字符限制；用限时子进程验证多行未闭合引用，保留原发布说明渲染测试。 |

官方依据：[body-parser](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828)、[follow-redirects](https://github.com/follow-redirects/follow-redirects/releases/tag/v1.16.1)、[引用解析](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-gfr2-rv44-r23c)、[smartquotes](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-r7fv-28h4-cvq7)。

完整 npm 审计另发现基线 Scout 未列出的 `qs` 中危 CVE-2026-110816（GHSA-6pq8-jhm2-2vcw），影响 comma 格式序列化带非函数 toString 的数组。同步将现有 override 从 6.16.0 更新至 6.16.1；保留正常表单、查询及序列化回归。它与 Express 的连带告警属于同一根因，不重复计算为两个 CVE。[公告](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw)。

文档站单独审计另发现 Vite 6.4.3 的五项开发服务器/编辑器漏洞（含 Windows 命令注入）。沿用现有 override 更新到同主版本 6.4.5，并在 Docs Pages 构建前增加高危审计；不更换 VitePress，也不把文档开发依赖算成已进入应用运行镜像。[Windows 编辑器公告](https://github.com/advisories/GHSA-587h-7wmj-h5pm)、[跨源脚本公告](https://github.com/advisories/GHSA-9jrq-w75r-8gcw)、[文件访问公告](https://github.com/advisories/GHSA-rq7h-c2jc-7f22)。

## 其余 62 条基线告警

此表覆盖剩余每个 CVE。除明确列出的架构/使用条件外，**不以“低危”“系统自带”或启动成功作为不适用证明**。继续使用 Bookworm 官方包；不混用其他 Debian 发行版的 glibc，不强制删除 essential 包。

| 源码包及基线版本 | CVE 与等级 | 处置及需要保留的证据 |
| --- | --- | --- |
| util-linux 2.38.1-5+deb12u3 | 高：CVE-2026-76642、CVE-2026-53615、CVE-2026-78408、CVE-2026-78410、CVE-2026-78409、CVE-2026-53613；中：CVE-2026-13595；低：CVE-2022-0563、CVE-2025-14104 | Bookworm 暂无适用修复。检查 mount/nsenter/chfn/chsh 等实际程序、挂载与本地权限条件；可选最小权限配置能限制提权/挂载，但不算修复库本身。[跟踪](https://security-tracker.debian.org/tracker/source-package/util-linux)。 |
| zlib 1:1.2.13.dfsg-1 | 高：CVE-2026-85091 | 无 Bookworm 修复版本；上游受影响范围与 Debian 包标记存在需要核对的差异，不能凭版本号直接排除。保留动态链接证据，涉及 gzwrite/gzprintf 的代码还需逐项判定。[跟踪](https://security-tracker.debian.org/tracker/CVE-2026-85091)。 |
| perl 5.36.0-7+deb12u4 | 高：CVE-2026-82560；中：CVE-2026-15534；低：CVE-2023-31486、CVE-2011-4116 | 检查实际安装的 Perl 模块，特别是 Pod::Text；未安装某模块只能排除该模块路径，不能排除 Perl 其余问题。必需 perl-base 保留，等待官方补丁。[跟踪](https://security-tracker.debian.org/tracker/source-package/perl)。 |
| glibc 2.36-9+deb12u14 | 中：CVE-2026-86805；低：CVE-2026-97399、CVE-2026-95818、CVE-2019-1010025、CVE-2019-9192、CVE-2010-4756、CVE-2019-1010023、CVE-2019-1010024、CVE-2018-20796、CVE-2019-1010022 | 保留核心库；核实架构、setuid/动态加载条件、protected_hardlinks 与具体函数。无适用补丁或调用证据不足的继续列为未解决，不宣称全部不可达。[跟踪](https://security-tracker.debian.org/tracker/source-package/glibc)。 |
| tar 1.34+dfsg-1.2+deb12u1 | 中：CVE-2025-45582；低：CVE-2005-2541 | 前者被上游争议，涉及多次向同一目录解包不可信 tar；BFB 迁移用 ZIP。构建仅解开经 SHA256 验证的固定 FFmpeg 包，目录独立。保留路径检查与来源验证，不把有争议等同于已修复。[依据](https://security-tracker.debian.org/tracker/CVE-2025-45582)。 |
| gnutls28 3.7.9-2+deb12u7 | 低：CVE-2026-67693、CVE-2026-95210、CVE-2011-3389、CVE-2026-88648、CVE-2026-95184、CVE-2026-95209、CVE-2026-88647 | 必需 TLS 库保留；核实 aria2 的真实后端、证书及域名验证行为。禁止关闭证书检查，HTTP 下载最低 TLS 1.2；仍无修复且可达的记录为未解决。[跟踪](https://security-tracker.debian.org/tracker/source-package/gnutls28)。 |
| systemd 252.39-1~deb12u2 | 低：CVE-2013-4392、CVE-2023-31438、CVE-2023-31439、CVE-2023-31437 | 源码包命中不等于安装/运行 systemd 或 journald。记录实际库、程序是否存在及 tini 启动方式；不能据此忽略同包的其他新问题。[跟踪](https://security-tracker.debian.org/tracker/source-package/systemd)。 |
| sqlite3 3.40.1-2+deb12u2 | 低：CVE-2025-52099、CVE-2025-29088、CVE-2025-70873、CVE-2021-45346 | 分别记录系统 SQLite 与 better-sqlite3 实际 sqlite_version/source_id 和动态链接；系统库存在不代表 BFB 数据库链接该库。未验证的函数/扩展不标为不适用。[跟踪](https://security-tracker.debian.org/tracker/source-package/sqlite3)。 |
| coreutils 9.1-1 | 低：CVE-2025-5278、CVE-2017-18018、CVE-2026-56392、CVE-2026-56391 | 保留必需工具；核查 sort/chown/unexpand/uniq 对应输入和调用。应用不经 shell 传递视频标题等参数，继续由参数数组启动进程；不强制移除 essential coreutils。[跟踪](https://security-tracker.debian.org/tracker/source-package/coreutils)。 |
| libgcrypt20 1.10.1-3+deb12u1 | 低：CVE-2024-2236、CVE-2018-6829 | 分别核对 RSA 解密时序与直接 ElGamal 用法；库存在不足以证明这些算法被调用。保留必要间接依赖，未核实部分仍未解决。[RSA](https://security-tracker.debian.org/tracker/CVE-2024-2236)、[ElGamal](https://security-tracker.debian.org/tracker/CVE-2018-6829)。 |
| c-ares 1.18.1-3 | 低：CVE-2023-31124、CVE-2023-31147 | 分清 Node 内置 c-ares 与系统库；检查交叉编译和随机源回退条件，不为消除告警破坏正常 DNS。[跟踪](https://security-tracker.debian.org/tracker/source-package/c-ares)。 |
| openssl 3.0.22-1~deb12u2 | 低：CVE-2025-27587、CVE-2010-0928 | 前者限定 PowerPC，当前 amd64 不满足；后者涉及特殊硬件电压故障注入，不是普通网页请求攻击。实际架构及系统/Node 内置 OpenSSL 版本均须保留。更换架构时重新复核。[前者](https://security-tracker.debian.org/tracker/CVE-2025-27587)、[后者](https://security-tracker.debian.org/tracker/CVE-2010-0928)。 |
| libxml2 2.9.14+dfsg-1.3~deb12u6 | 低：CVE-2025-12863、CVE-2026-11979 | 后者涉及 xmlcatalog --shell，检查实际程序是否安装。前者 Debian 条目缺少可用判定，保留待核实；不能笼统写成“XML 不受影响”。[前者](https://security-tracker.debian.org/tracker/CVE-2025-12863)、[后者](https://security-tracker.debian.org/tracker/CVE-2026-11979)。 |
| dash 0.5.12-2 | 低：CVE-2026-102474、CVE-2026-102473 | 核查 printf Unicode 转义与特殊 glob 条件；不新增对不可信标题/文件名的 shell 拼接。上游尚无包补丁，保留跟踪。[前者](https://security-tracker.debian.org/tracker/CVE-2026-102474)、[后者](https://security-tracker.debian.org/tracker/CVE-2026-102473)。 |
| aria2 1.36.0-1 | 低：CVE-2026-71832、CVE-2026-75421 | 上游修复 PR 未合并。BFB/固定 BBDown 直接传 HTTP URL，不用 -i；关闭自动 torrent/Metalink 跟随，保留续传。真实 HTTP/TLS/中断测试验证行为；属于缓解，不是二进制已打补丁。[torrent](https://github.com/aria2/aria2/issues/2371)、[输入文件](https://github.com/aria2/aria2/issues/2375)。 |
| gnupg2 2.2.40-1.1+deb12u2 | 低：CVE-2022-3219 | 核实 gpg/gpgv 实际程序与不可信密钥导入路径；不因 gpgv 用于发行版签名验证而将其移除。上游未提供修复。[依据](https://security-tracker.debian.org/tracker/CVE-2022-3219)。 |
| apt 2.6.1 | 低：CVE-2011-3374 | Debian 记录因未定义 keyring URI 而不可利用；保留官方签名验证，不引入 apt-key 下载远端密钥路径。[依据](https://security-tracker.debian.org/tracker/CVE-2011-3374)。 |
| shadow 1:4.13+dfsg1-1+deb12u2 | 低：CVE-2007-5686 | 涉及系统登录失败记录权限，不是 BFB 管理员 Web 会话。核查实际程序与登录配置；不移除基础账号数据。[依据](https://security-tracker.debian.org/tracker/CVE-2007-5686)。 |
| gcc-12 12.2.0-14+deb12u1 | 低：CVE-2022-27943 | 核查实际文件；libgcc/libstdc++ 运行库不能当成已安装编译器/nm。漏洞涉及 demangler，对缺失的工具路径可记录不适用，保留媒体所需运行库。[依据](https://security-tracker.debian.org/tracker/CVE-2022-27943)。 |
| diffutils 1:3.8-4 | 低：CVE-2026-53910 | 涉及 diff3 使用攻击者可控 diff 程序，BFB 不调用此流程；基础包保留，上游将其视为可忽略的安全影响。配置或调用变化后重审。[依据](https://security-tracker.debian.org/tracker/CVE-2026-53910)。 |

## 镜像与发布检查

1. `npm audit --omit=dev --audit-level=high` 检查本次安装的生产依赖；不能用它代替最终镜像扫描。
2. 保留独立 `runtime-tools` 层及固定媒体工具层。移除闲置 npm/npx、Yarn 和 Corepack；必需系统库、证书、Debian 包元数据和版权材料保留。
3. 候选镜像以 `--network none --cap-drop ALL --security-opt no-new-privileges:true` 启动，数据与缓存使用隔离 tmpfs；检查启动、SQLite、鉴权及全部媒体 CLI。该限制不改变现有数据 UID。
4. 在同一候选容器执行 `scripts/image-security-inventory.mjs`：验证四项实际运行依赖的安全下限；记录全部 Debian 包、Node 内置组件、真正的 SQLite 引擎、工具是否存在、动态库链接、Pod::Text 和内核权限观察。观察结果不自动生成“不适用”或扫描例外。
5. 对同一固定摘要运行 Docker Scout，保留所有等级的 SARIF；再单独以 `only-fixed=true` 和 `critical,high` 阻止发布。基础层、Scout 抑制项、VEX 不适用项均不被过滤。网络/扫描失败同样停止推广。
6. `candidate-security-<run>-<attempt>` artifact 保留运行清单及完整扫描报告 30 天，失败的检查也保留已有证据；最终标签仅在所有检查成功且提交仍有效时推广。

可选权限覆盖文件为 `docker-compose.security.yml`。已有部署需先检查挂载目录权限，再使用 `docker compose -f docker-compose.yml -f docker-compose.security.yml up -d`；普通 Compose 不被自动改写。

## 二进制覆盖与复核

FFmpeg 固定 `ffmpeg-bfb-8.1.2-20260711.1`，BBDown 固定 `bfb-2.0.7` / `35a26fab051528532e126af7271dc1ca1be1746c`。分别核对源码、构建依赖与[FFmpeg 安全公告](https://ffmpeg.org/security.html)，将系统包扫描未覆盖的静态组件列为待核实项。更新媒体工具后执行下载、合并、探测、编码及回滚验收。

基线里暂缺补丁、上游争议或待核实的记录，在基础镜像、架构、工具版本、权限或调用方式改变时，以及下次正式发布前重新复核。有了适用补丁，发布检查会立即阻止继续携带可修复的严重/高危问题。

## 补充扫描与覆盖边界

2026-10-28 使用 Trivy 0.76.1 对独立的 Linux/amd64 候选镜像补充扫描，得到 **125 个唯一告警标识：120 个 CVE、4 个 TEMP、1 个 DLA**。按该扫描器分级为严重 3、高 19、中 44、低 57、未知 2；按二进制包逐条计数为 258 条，同一个 util-linux CVE 会在多个同源码包中重复出现。它与前文 Scout 基线的镜像、扫描器和计数口径不同，不能直接相减，也不能据此判断新增数字都是应用改动引入。

以下是该候选的组件与覆盖范围记录，不代表所有后续发布镜像的状态：

| 项目 | 核验结果与限制 |
| --- | --- |
| Node 与内置组件 | Node 24.22.1、Undici 7.30.1、OpenSSL 3.5.9；系统 OpenSSL 为 3.0.22-1~deb12u2。 |
| 应用依赖 | 镜像实际安装 body-parser 1.20.9、follow-redirects 1.16.1、markdown-it 15.0.3、qs 6.16.1。根项目和文档的完整 npm 审计均为 0。 |
| 数据库 | better-sqlite3 实际引擎为 SQLite 3.53.2，动态链接中没有系统 libsqlite3；aria2 仍链接系统 libsqlite3 3.40.1，不能将后者当作已经升级。 |
| 最小权限 | 在 cap_drop=ALL、no-new-privileges 下核对 CapEff=0、NoNewPrivs=1、protected_hardlinks=1。限制权限属于缓解，不代表原组件已修复。 |
| 下载与媒体 | 真实 aria2 通过刷新 URL 后的断点续传、禁止 torrent/Metalink 跟随、可信主机名成功及错误证书/主机名拒绝测试；使用固定 FFmpeg/ffprobe 验证下载清单及媒体规格。 |
| 工具包依赖 | 固定 BBDown 源码的 NuGet 全部传递依赖审计未报告已知漏洞；这不覆盖 Native AOT 内嵌 .NET 或 FFmpeg 静态库。BBDown 发布元数据中的 SDK 为 9.0.306，源码依赖审计不能证明内嵌运行时已更新。 |

本次扫描的完整告警已保留，当时未发现 Trivy 认定 Bookworm 已有修复版本的严重/高危项。唯一列出适用更新的 DLA-4854-1 是 tzdata 时区数据库更新通知。后续发布按各自固定镜像摘要保存 Actions 运行清单、隔离验收和完整 Scout 报告。

### 新增严重项与实际组件判断

- **CVE-2023-45853（MiniZip）**：[Debian 明确说明](https://security-tracker.debian.org/tracker/CVE-2023-45853)该 zlib 构建没有编入 contrib/minizip；当前镜像也没有 minizip 包。此告警不适用于这份 Debian zlib 二进制，不能扩大为“所有静态压缩库安全”。
- **CVE-2025-7458（SQLite）**：BFB 的 3.53.2 引擎不在受影响区间；系统 3.40.1 包仍在，并被 aria2 链接。系统库继续跟踪，不能以 BFB 引擎较新为由隐藏整条告警。
- **CVE-2026-6653（libxml2）**：Debian 仍列为 Bookworm 待处理，未提供本发行版修复。aria2 自动 Metalink 跟随已禁用，但库仍存在；不能据此认定所有 XML 路径不可达，也不跨发行版强换核心库。

### 其余新增告警的处理边界

扫描发现的其他标识按组件补列如下；**未列出适用补丁的项默认保留为未解决/待核实**。下列说明只排除明确验证的触发路径，不配置扫描器豁免。

| 组件 | 补充标识 | 处理边界 |
| --- | --- | --- |
| aria2 | CVE-2026-8367 | GnuTLS 后端的证书用途（EKU）检查仍未修复：隔离对照中，同一 CA 签发且 SAN 匹配的 serverAuth 和仅 clientAuth 证书均被接受。攻击仍需匹配域名的可信链及对应私钥；CA、域名校验和最低 TLS 版本不能代替用途检查。Bookworm 暂无官方补丁，继续保留未解决状态。[跟踪](https://security-tracker.debian.org/tracker/CVE-2026-8367)。 |
| util-linux | CVE-2026-27456、CVE-2026-3184 | 补充挂载和主机名相关条件；当前容器无 fstab 用户挂载条目，最小权限配置限制挂载，原组件仍无补丁。 |
| gzip | CVE-2026-41992、CVE-2026-41991 | 涉及 LZH 解压和 gzexe 临时文件；BFB 不调用这些流程，但工具存在，保留跟踪，不等同于 Node 的 zlib 已受影响。 |
| acl / attr | CVE-2026-54369、CVE-2026-54370、CVE-2026-54371 | 涉及特权 ACL/扩展属性操作的符号链接竞争；保留现有路径、符号链接及数据保护，不删除基础依赖。 |
| bzip2 | CVE-2026-42250 | 当前未安装 bzip2recover；不扩展该结论到所有压缩操作。 |
| c-ares | CVE-2024-25629 | 区分 Node 内置 DNS 库与 aria2 动态系统库；仍需跟踪系统库。 |
| glibc | CVE-2026-18374、CVE-2026-19499、CVE-2026-19542、CVE-2026-5435、CVE-2026-5450、CVE-2026-5928、CVE-2026-6238、CVE-2026-6368、CVE-2026-6791、CVE-2026-77117、CVE-2026-80489、CVE-2026-8674、CVE-2026-89092 | 包含格式化、字符转换及 DNS 路径；未证明不可达，保留未解决，不替换 essential glibc。 |
| p11-kit | CVE-2026-13757、CVE-2026-18938 | 涉及 RPC 属性解析及 32 位长度；当前 amd64 只能排除明确的 32 位条件，不能排除全部递归问题。 |
| PAM | CVE-2024-10041、CVE-2026-54411 | 与系统登录及 pam_userdb 条件有关；不把它们混同于 BFB Web 登录，也不声称系统包已修复。 |
| SQLite | CVE-2026-11822、CVE-2026-11824、CVE-2025-7709、CVE-2026-50812、CVE-2026-50813 | FTS5 的两项高危已由 BFB 实际 3.53.2 引擎覆盖修复；系统库继续保留告警。Session 扩展及其他函数问题不能仅靠该版本结论排除。 |
| systemd | CVE-2026-16742、CVE-2026-15059、CVE-2026-40228 | 实测 systemd-homed、systemd-oomd、journald 均未安装；镜像有 libsystemd0，不能把源码包级匹配当作守护进程已经运行。 |
| libtasn1 | CVE-2025-13151 | 保留 GnuTLS 所需依赖及未解决状态，等待适用修复。 |
| ncurses | CVE-2025-69720、CVE-2023-50495、CVE-2025-6141 | infocmp 实际存在，BFB 无对应调用；不删除基础终端组件或伪称组件不存在。 |
| libxml2 | CVE-2026-74860、CVE-2026-86138、CVE-2026-86140、CVE-2026-86142、CVE-2026-86143、CVE-2026-86144、CVE-2026-76781 | Python 绑定未安装只能排除相应绑定路径；解析、XPointer、XInclude 等问题继续跟踪。不能用关闭 Metalink 消除全部 XML 告警。 |
| Perl | CVE-2026-9538 | 实测 Archive::Tar 未安装，与 Pod::Text 一样按缺失模块判断；perl-base 保留。 |
| GCC / libstdc++ | CVE-2026-102010、CVE-2026-95619 | 不把编译器/模板代码与已安装运行库混为一谈；new 运算符等运行库问题保留未解决。 |
| GnuPG | CVE-2025-30258、CVE-2025-68972、CVE-2026-105712、CVE-2026-57062 | 当前有 gpgv、无 gpg；继续保留签名验证及未核实路径，不因删除命令而推断库全部安全。 |
| tar | CVE-2026-18477、CVE-2026-18508、CVE-2026-5704、TEMP-0290435-0B57B5 | BFB 迁移使用 ZIP；固定工具构建只处理经过摘要验证的包，不接入任意远端 tar。原 tar 包未修复。 |
| zlib | CVE-2026-27171 | CRC32 combine 的使用条件仍需核实，不与已确认不适用的 MiniZip 告警一并消除。 |
| coreutils / shadow / bash / sysvinit | CVE-2016-2781、CVE-2024-56433、TEMP-0628843-DBAD28、TEMP-0841856-B18BAF、TEMP-0517018-A83CE6 | 保留本地会话、子 UID、安装器及权限条件的区别；没有相应证明的不标为已修复。 |

Native AOT 的内嵌运行时、FFmpeg 静态依赖仍是扫描覆盖的限制。BBDown 的 NuGet 审计没有告警不代表它已包含 [.NET 最新安全补丁](https://dotnet.microsoft.com/en-us/download/dotnet/9.0)；需要单独更新工具包及验收，不能只重新构建 BFB 就宣称修复了内嵌组件。
