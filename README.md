# 🌟 个人导航首页

一个现代化、美观、极简的个人导航首页，集成搜索引擎切换和快捷链接导航功能。

![版本](https://img.shields.io/badge/version-1.0.0-blue)
![许可证](https://img.shields.io/badge/license-MIT-green)

## ✨ 特性

### 🎨 视觉设计
- **现代化玻璃态设计**：采用流行的 Glassmorphism（玻璃态）设计风格
- **动态渐变背景**：紫色系渐变背景，带有动态网格动画
- **流畅动画效果**：页面元素淡入、卡片悬停、按钮交互等多种动画
- **微交互反馈**：悬停、点击、聚焦等状态都有明确的视觉反馈
- **响应式布局**：完美适配桌面端、平板和移动设备

### 🔍 搜索功能
- **双引擎支持**：Google 和百度搜索引擎
- **一键切换**：点击按钮即可切换搜索引擎
- **Enter 搜索**：输入关键词后按 Enter 键即可搜索
- **实时指示器**：显示当前使用的搜索引擎
- **自动聚焦**：页面加载后自动聚焦搜索框

### 🔗 快捷导航
- **预设链接**：包含 GitHub、YouTube、Twitter、Reddit、Stack Overflow、哔哩哔哩等常用网站
- **精美卡片**：每个链接都有图标、标题和描述
- **悬停效果**：鼠标悬停时卡片会抬升并显示光泽动画
- **点击涟漪**：点击卡片时会有涟漪效果反馈

### ⌨️ 快捷键支持
- `Ctrl/Cmd + K` - 聚焦搜索框
- `Ctrl/Cmd + 1` - 切换到 Google
- `Ctrl/Cmd + 2` - 切换到百度
- `Esc` - 清空搜索框

## 🚀 使用方法

### 方法一：直接打开
1. 下载所有文件（`index.html`、`style.css`、`script.js`）
2. 双击 `index.html` 文件在浏览器中打开
3. 开始使用！

### 方法二：本地服务器（推荐）
使用本地服务器可以获得更好的体验：

**使用 Python：**
```bash
# Python 3
python -m http.server 8000

# Python 2
python -m SimpleHTTPServer 8000
```

**使用 Node.js：**
```bash
# 安装 http-server
npm install -g http-server

# 运行服务器
http-server
```

然后在浏览器中访问 `http://localhost:8000`

### 方法三：设置为浏览器首页
1. 将项目部署到 GitHub Pages 或其他静态托管服务
2. 在浏览器设置中将该 URL 设置为首页

## 📁 项目结构

```
personal-start-page/
├── index.html          # 页面结构
├── style.css           # 样式文件
├── script.js           # 交互逻辑
└── README.md           # 项目说明
```

## 🎨 自定义配置

### 修改搜索引擎
在 `script.js` 中修改 `searchEngines` 对象：

```javascript
const searchEngines = {
    google: {
        name: 'Google',
        url: 'https://www.google.com/search?q=',
        placeholder: '搜索 Google...'
    },
    // 添加更多搜索引擎...
};
```

### 修改导航链接
在 `index.html` 中的 `.navigation-links` 部分添加或修改链接卡片：

```html
<a href="你的链接" class="nav-card" target="_blank">
    <div class="nav-icon">
        <!-- 你的图标 SVG -->
    </div>
    <div class="nav-info">
        <div class="nav-title">网站名称</div>
        <div class="nav-desc">网站描述</div>
    </div>
</a>
```

### 修改配色方案
在 `style.css` 的 `:root` 部分修改 CSS 变量：

```css
:root {
    --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    --secondary-gradient: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
    /* 修改其他颜色变量... */
}
```

## 🌈 配色方案

当前使用的配色方案：
- **主色调**：紫色系渐变 (`#667eea` → `#764ba2` → `#f093fb`)
- **玻璃效果**：半透明白色 + 模糊背景
- **文字颜色**：白色及其半透明变体
- **阴影**：多层次阴影增强立体感

## 🔧 技术栈

- **HTML5** - 语义化结构
- **CSS3** - 现代化样式（Flexbox、Grid、动画、backdrop-filter）
- **Vanilla JavaScript** - 原生 JS，无依赖

## 📱 浏览器兼容性

- ✅ Chrome/Edge 90+
- ✅ Firefox 88+
- ✅ Safari 14+
- ✅ Opera 76+

**注意**：部分老旧浏览器可能不支持 `backdrop-filter` 属性（玻璃态效果）

## 🎯 后续规划

### 第二阶段功能
- [ ] 自定义链接编辑功能
- [ ] 本地存储配置（LocalStorage）
- [ ] 添加更多搜索引擎
- [ ] 深色/浅色主题切换
- [ ] 拖拽排序导航链接

### 扩展功能
- [ ] 时间和日期显示
- [ ] 天气模块
- [ ] 搜索建议
- [ ] 壁纸更换
- [ ] 备忘录/待办事项
- [ ] RSS 订阅阅读器

## 📝 更新日志

### v1.0.0 (2026-01-28)
- ✨ 初始版本发布
- 🎨 实现玻璃态设计风格
- 🔍 支持 Google 和百度搜索
- 🔗 添加 6 个预设常用网站链接
- ⌨️ 添加快捷键支持
- 📱 完整响应式设计

## 📄 许可证

MIT License - 随意使用、修改和分发

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 💡 灵感来源

本项目设计灵感来源于：
- macOS Big Sur 的设计语言
- Glassmorphism 设计趋势
- 各类现代化浏览器扩展

---

**享受你的个性化浏览体验！** 🎉

如有问题或建议，欢迎反馈。
