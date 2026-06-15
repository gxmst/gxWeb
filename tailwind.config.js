/** @type {import('tailwindcss').Config} */
module.exports = {
  // content 必须同时扫描前端 HTML 和 Python——spider.py 也在拼 Tailwind class（GitHub/HN/V2EX 块）。
  content: [
    "./public/index.html",
    "./spider.py",
  ],
  theme: {
    extend: {},
  },
  // 保险：少数 class 仅在运行时由 JS 按状态拼接（行情涨跌色、连接状态红/黄/绿点）。
  // 实测它们在源码里均以完整字符串出现、扫描可命中，此处再兜底一层，防止以后重构源码时漏掉。
  safelist: [
    "text-rose-400", "text-emerald-400",
    "bg-red-500", "bg-amber-400", "bg-amber-500", "bg-green-400", "bg-green-500",
    "text-red-400", "text-amber-400", "text-green-400",
    "text-sm", "text-base", "text-lg",
    "animate-ping", "animate-pulse",
  ],
  plugins: [],
};
