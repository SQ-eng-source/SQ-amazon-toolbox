# SQ-AMAZON-TOOLBOX

亚马逊运营工具台 · 纯静态网页，离线可用，无需后端。

在线地址：https://sq-eng-source.github.io/SQ-amazon-toolbox/

## 结构

```
index.html          总工具台（左侧导航切换各工具）
tools/              各独立工具，单文件 HTML，可单独分发
```

## 更新方式

改完文件 → `git add -A && git commit -m "说明" && git push`，约 1 分钟后线上生效。

## 说明

- 所有计算在浏览器本地完成，不上传任何数据；
- 产品记录保存在浏览器 localStorage，换设备/清缓存会丢，建议用工具内的「导出 Excel」备份；
- 汇率由公开接口实时拉取，失败时回退预置值。
