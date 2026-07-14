import { createRequire } from "node:module";
import { defineConfig } from "vitepress";

const require = createRequire(import.meta.url);
const rootPackage = require("../../package.json") as { version: string };
const repository = "https://github.com/minori0721/Bili-favorites-backup";

export default defineConfig({
  lang: "zh-CN",
  title: "Bili-favorites-backup",
  titleTemplate: ":title | BFB 文档",
  description: "把B站收藏夹持续归档到AList云盘，并确认远端文件真的存在。",
  base: "/Bili-favorites-backup/",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: "https://minori0721.github.io/Bili-favorites-backup/",
  },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/Bili-favorites-backup/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#159570" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Bili-favorites-backup 文档" }],
    ["meta", { property: "og:description", content: "面向AList云盘的B站收藏夹持续备份系统" }],
  ],
  markdown: {
    lineNumbers: true,
  },
  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "BFB 文档",
    nav: [
      { text: "快速开始", link: "/guide/introduction" },
      { text: "功能演示", link: "/features/workflow" },
      { text: "问题排查", link: "/troubleshooting/docker-hub" },
      { text: `v${rootPackage.version}`, link: "/reference/releases" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "快速开始",
          items: [
            { text: "项目定位", link: "/guide/introduction" },
            { text: "5分钟 Docker 部署", link: "/guide/docker" },
            { text: "首次登录", link: "/guide/first-login" },
            { text: "添加 B 站账号", link: "/guide/add-account" },
            { text: "完成首次同步", link: "/guide/first-sync" },
          ],
        },
      ],
      "/alist/": [
        {
          text: "连接 AList",
          items: [
            { text: "选择接入方式", link: "/alist/overview" },
            { text: "使用内置 AList", link: "/alist/built-in" },
            { text: "接入已有 AList", link: "/alist/existing" },
            { text: "添加网盘与 WebDAV 路径", link: "/alist/storage" },
            { text: "升级与备份 AList", link: "/alist/upgrade" },
          ],
        },
      ],
      "/features/": [
        {
          text: "功能演示",
          items: [
            { text: "整体运行流程", link: "/features/workflow" },
            { text: "四列任务队列", link: "/features/queue" },
            { text: "上传确认", link: "/features/upload-verification" },
            { text: "异常熔断与恢复", link: "/features/recovery" },
            { text: "充电视频", link: "/features/charging" },
            { text: "分P历史归档", link: "/features/history" },
            { text: "共享画质重调", link: "/features/quality-upgrade" },
          ],
        },
      ],
      "/operations/": [
        {
          text: "日常维护",
          items: [
            { text: "更新镜像", link: "/operations/update" },
            { text: "日志", link: "/operations/logs" },
            { text: "缓存与残片", link: "/operations/cache" },
            { text: "迁移、备份与回滚", link: "/operations/migration" },
            { text: "安全配置", link: "/operations/security" },
          ],
        },
      ],
      "/troubleshooting/": [
        {
          text: "问题排查",
          items: [
            { text: "Docker Hub 拉取超时", link: "/troubleshooting/docker-hub" },
            { text: "B站风控与账号失效", link: "/troubleshooting/bilibili" },
            { text: "AList 405", link: "/troubleshooting/alist-405" },
            { text: "远端延迟可见", link: "/troubleshooting/visibility-delay" },
            { text: "缓存已满", link: "/troubleshooting/cache-limit" },
            { text: "容器重启恢复", link: "/troubleshooting/restart" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "参考",
          items: [
            { text: "配置项", link: "/reference/configuration" },
            { text: "状态含义", link: "/reference/statuses" },
            { text: "用户视角架构", link: "/reference/architecture" },
            { text: "兼容性边界", link: "/reference/compatibility" },
            { text: "版本与升级记录", link: "/reference/releases" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: repository }],
    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
          modal: {
            noResultsText: "没有找到相关内容",
            resetButtonTitle: "清除查询",
            footer: {
              selectText: "选择",
              navigateText: "切换",
              closeText: "关闭",
            },
          },
        },
      },
    },
    outline: { level: [2, 3], label: "本页内容" },
    docFooter: { prev: "上一页", next: "下一页" },
    lastUpdated: { text: "最后更新于", formatOptions: { dateStyle: "medium", timeStyle: "short" } },
    editLink: {
      pattern: `${repository}/edit/main/docs/:path`,
      text: "在 GitHub 上编辑此页",
    },
    notFound: {
      title: "页面不存在",
      quote: "这个地址没有对应的文档，可能是页面已经移动。",
      linkLabel: "返回文档首页",
      linkText: "返回首页",
    },
    footer: {
      message: "面向AList云盘的B站收藏夹持续备份系统",
      copyright: "Bili-favorites-backup",
    },
  },
});
