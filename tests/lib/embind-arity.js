'use strict';

// Reads how many arguments each function of the WebAssembly module takes, from its Embind bindings: every
// `emscripten::function("<name>", &<function>)` of wasm/*.cpp, with the parameters of the declaration of <function> in
// wasm/*.hpp (or of its definition in wasm/*.cpp). Embind on the TV throws a BindingError when a call passes another
// number of arguments, and the stub of the module in the browser tests (browser/mocks/moonlight-wasm.js) does the same
// with this table, which is read from the sources at every run so that it can't go stale.

const fs = require('fs');
const path = require('path');

const BINDING = /emscripten::function\(\s*"(\w+)"\s*,\s*&(\w+)\s*\)/g;

// The source without comments, with the strings kept (a comment could hold a signature that isn't one)
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (match) => (match[0] === '/' ? match.replace(/[^\n]/g, ' ') : match));
}

// The number of parameters of a parameter list (the text between its parentheses): the commas outside <> and ()
function countParameters(list) {
  const text = list.replace(/\s+/g, ' ').trim();
  if (text === '' || text === 'void') {
    return 0;
  }
  let depth = 0;
  let count = 1;
  for (const ch of text) {
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      count++;
    }
  }
  return count;
}

// The parameter list of the first declaration or definition of a function at the top level of a source (a line that
// starts with its return type), or null
function findParameterList(source, name) {
  const pattern = new RegExp('^(?:[A-Za-z_][\\w:<>,]*[ \\t*&]+)+' + name + '[ \\t]*\\(', 'gm');
  const match = pattern.exec(source);
  if (!match) {
    return null;
  }
  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '(') {
      depth++;
    } else if (source[i] === ')') {
      depth--;
    }
  }
  return depth === 0 ? source.slice(start, i - 1) : null;
}

// The arity of every bound function: { <name in JavaScript>: <number of arguments> }, from the sources of a folder
// (default: wasm/ of the repository). Throws when a bound function has no signature in the sources.
function readEmbindArity(repoRoot, folder) {
  const dir = folder || path.join(repoRoot, 'wasm');
  const files = fs.readdirSync(dir).filter((name) => /\.(cpp|hpp)$/.test(name)).sort();
  const read = (name) => stripComments(fs.readFileSync(path.join(dir, name), 'utf8'));
  // Declarations of the headers first, then the definitions
  const headers = files.filter((name) => /\.hpp$/.test(name)).map(read);
  const sources = files.filter((name) => /\.cpp$/.test(name)).map(read);
  const arity = {};
  sources.forEach((source) => {
    let match;
    BINDING.lastIndex = 0;
    while ((match = BINDING.exec(source)) !== null) {
      const [, js, cpp] = match;
      let list = null;
      for (const text of headers.concat(sources)) {
        list = findParameterList(text, cpp);
        if (list !== null) {
          break;
        }
      }
      if (list === null) {
        throw new Error(`The signature of ${cpp}, which Embind binds as ${js}, was not found in ${dir}`);
      }
      arity[js] = countParameters(list);
    }
  });
  return arity;
}

module.exports = { readEmbindArity, countParameters, findParameterList, stripComments };
