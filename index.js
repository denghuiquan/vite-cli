#!/usr/bin/env node
const path = require('path')
const koa = require('koa')
const send = require('koa-send')
const compiler = require('@vue/compiler-sfc')

const { parse, compileScript, compileTemplate, compileStyleAsync } = compiler
const {
  parseVueRequest,
  streamToString,
  stringToStream,
  attrsToQuery
} = require('./utils')

const server = new koa()

// 3、在处理静态文件之前，加载第三方模块和或自定义模块。
// 处理ctx.path -> /@modules/*的情况
// .将以/@modules开头的路径重新指向node_modules目录的模块文件
server.use(async (ctx, next) => {
  // 处理 ctx.path -> /@modules/*
  if (ctx.path.startsWith('/@modules/')) {
    const moduleName = ctx.path.substring('/@modules/'.length)
    // 读取模块包中的package.json内容
    const pkgPath = path.join(
      process.cwd(),
      'node_modules',
      moduleName,
      'package.json'
    )
    const pkg = require(pkgPath)
    // 解析出包的module文件路径，进行实际资源访问路径的拼凑
    ctx.path = path.join('/node_modules', moduleName, pkg.module)
  }
  await next()
})

// 1、创建静态文件服务器
server.use(async (ctx, next) => {
  // 开启静态文件服务器，配置默认路径设置index为index.html
  await send(ctx, ctx.path, { root: process.cwd(), index: 'index.html' })
  await next()
})

// 处理单文件组件
// 4.1 将以vue结尾的文件响应格式改成application/javascript, 然后输出流
// 4.2 将没有参数的vue文件解析js内容（因为JavaScript文件）
// 4.3 将有参数的vue文件解析template内容返回解析后的内容
server.use(async (ctx, next) => {
  const { filename, query } = parseVueRequest(ctx.url)
  // sfc:.vue
  const include = /\.vue$/
  // custom element sfc: .ce.vue
  const customElement = /\.ce\.vue$/

  if (include.test(filename)) {
    const contents = await streamToString(ctx.body)
    const { descriptor } = parse(contents)

    let { code, map } = {}
    let transformResult = null

    if (!query.vue) {
      // .vue
      if (descriptor.scriptSetup || descriptor.script) {
        code = `const _sfc_export = (sfc, props) => {
          const target = sfc;
          for (const [key, val] of props) {
            target[key] = val;
          }
          return target;
        }
        `
        const compiledScript = compileScript(descriptor, {
          sourceMap: true
        })
        code += compiledScript.content
        const bindings = compiledScript.bindings
        const renderFnName = 'render'

        const resultTemplate = compileTemplate({
          source: descriptor.template.content,
          inMap: compiledScript.map,
          compilerOptions: {
            bindingMetadata: bindings,
            transformAssetUrls: {
              includeAbsolute: false
            }
          }
        })
        // 处理 图片资源的 src
        if (resultTemplate.ast.imports && resultTemplate.ast.imports.length) {
          resultTemplate.ast.imports.forEach(item => {
            resultTemplate.code = resultTemplate.code
              .replace(`import ${item.exp.content} from '${item.path}'\n`, '')
              .replace(
                new RegExp(item.exp.content, 'g'),
                `"${path.join('src', item.path)}"`
              )
          })
        }

        // 把原来的export封装并添加vue的render函数后，重新export
        code = code.replace(/export\s+default\s+/g, 'const _sfc_script = ')

        const templateCode = resultTemplate.code.replace(
          /export\s+function\s+render/g,
          `function __${renderFnName}`
        )

        // 处理 style样式  // todo 处理第三方样式的 import
        if (descriptor.styles.length) {
          for (let i = 0; i < descriptor.styles.length; i++) {
            const style = descriptor.styles[i]
            const src = style.src || filename
            const attrsQuery = attrsToQuery(style.attrs, 'css')
            const srcQuery = style.src ? `&src` : ``
            const query = `?vue&type=style&index=${i}${srcQuery}`
            const styleRequest = src + query + attrsQuery
            if (style.content) {
              code += `\nimport ${JSON.stringify(styleRequest)}\n`
            }
          }
        }
        code += `
        ${templateCode}
        _sfc_script.${renderFnName} = __${renderFnName}
        export default _sfc_export(_sfc_script, [['${renderFnName}', __${renderFnName}], ['__file', "${filename}"]])
        `
      }
      transformResult = { code }
      ctx.type = 'application/javascript'
    } else {
      let block
      if (query.type === 'script') {
        // 这里可以结合使用缓存进行构建编译的优化
        block = descriptor.scriptSetup || descriptor.script
      } else if (query.type === 'template') {
        block = descriptor.template
      } else if (query.type === 'style') {
        block = descriptor.styles[query.index]
      } else if (query.index != null) {
        block = descriptor.customBlocks[query.index]
      }
      if (block) {
        code = block.content
        map = block.map
      }
      // .vue?vue&type=styles...
      if (query.type === 'template') {
        const result = compileTemplate({
          source: code,
          bindingMetadata: bindings
        })
        transformResult = { code: result.code || code, map }
        ctx.type = 'application/javascript'
      } else if (query.type === 'style') {
        // 这里可以对css样式使用相对应的预编译工具
        transformResult = await compileStyleAsync({
          id: `data-v-${descriptor.id}`,
          source: code,
          scoped: block.scoped
        })
        // vite的这部分做了缓存，并且是通过web socket进行通讯加载使之生效的
        transformResult.code = `(() => {
          let style = document.createElement('style');
          style.setAttribute('type', 'text/css');
          style.innerHTML = \`${transformResult.code}\`;
          document.head.appendChild(style);
        })()`
        ctx.type = 'application/javascript'
      }
    }

    code = transformResult.code
    map = transformResult.map
    if (code && typeof code === 'string') {
      ctx.body = stringToStream(code)
    }
  }

  await next()
})

// 2、修改请求的js资源的文件中引用第三方模块的资源请求路径
server.use(async (ctx, next) => {
  if (ctx.type === 'application/javascript') {
    const contents = await streamToString(ctx.body)
    // import vue from 'vue'  第三方模块加载地址修改
    // import App from './App.vue'  自定义模块加载地址修改
    // 针对上面的内容做匹配替换
    ctx.body = contents
      .replace(/(from\s+['|"])(?![\.\/])/g, '$1/@modules/')
      // 这里是hack Vite向前端返回了env.mjs暴露的process成员
      .replace(/process\.env\.NODE_ENV/g, '"development"')
  }
  await next()
})

server.listen(3000) // Todo: make it configable through cli options
console.log('Server is serveing: http://localhost:3000')
