const { Readable } = require('stream')
const querystring = require('querystring')
/**
 * 把stream流转换成string字符串
 * @param {Stream} stream
 * @returns {String}
 */
function streamToString (stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    stream.on('error', reject)
  })
}

/**
 * 把string字符串转换成stream流
 * @param {String} text
 * @returns {Streaam}
 */
function stringToStream (text) {
  const stream = new Readable()
  stream.push(text)
  stream.push(null)
  return stream
}

function parseVueRequest (id) {
  const [filename, rawQuery] = id.split(`?`, 2)
  const query = querystring.parse(rawQuery)
  if (query.vue != null) {
    query.vue = true
  }
  if (query.src != null) {
    query.src = true
  }
  if (query.index != null) {
    query.index = Number(query.index)
  }
  if (query.raw != null) {
    query.raw = true
  }
  return {
    filename,
    query
  }
}

const ignoreList = ['id', 'index', 'src', 'type', 'lang', 'module']
function attrsToQuery (attrs, langFallback, forceLangFallback = false) {
  let query = ``
  for (const name in attrs) {
    const value = attrs[name]
    if (!ignoreList.includes(name)) {
      query += `&${querystring.escape(name)}${
        value ? `=${querystring.escape(String(value))}` : ``
      }`
    }
  }
  if (langFallback || attrs.lang) {
    query +=
      `lang` in attrs
        ? forceLangFallback
          ? `&lang.${langFallback}`
          : `&lang.${attrs.lang}`
        : `&lang.${langFallback}`
  }
  return query
}

module.exports = {
  streamToString,
  stringToStream,
  parseVueRequest,
  attrsToQuery
}
