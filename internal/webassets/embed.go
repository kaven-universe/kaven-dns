package webassets

import "embed"

// Files contains the complete offline management console.
//
//go:embed public/index.html public/favicon.ico public/vendor/vue.global.prod.js
var Files embed.FS
