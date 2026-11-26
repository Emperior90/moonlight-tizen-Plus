'use strict';

// Reads how many arguments each function of the WebAssembly module takes, from its Embind bindings: every
// `emscripten::function("<name>", &<function>)` of wasm/*.cpp and wasm/*.hpp, and every unqualified `function(` inside an
// `EMSCRIPTEN_BINDINGS` block (after `using namespace emscripten`), with the parameters of the declaration of <function>
// in wasm/*.hpp (or of its definition in wasm/*.cpp). The function may be named with its namespace (`&ns::f`), and
// policies may follow it (`emscripten::allow_raw_pointers()`); a binding in any other form (a lambda, select_overload,
// explicit template arguments) is an error, not a binding left out, so that no function of the module goes unchecked.
// The `.function(` of a `class_` binds a method, not a function of the module, and isn't read. Embind on the TV throws a
// BindingError when a call passes another number of arguments, and the stub of the module in the browser tests
// (browser/mocks/moonlight-wasm.js) does the same with this table, which is read from the sources at every run so that
// it can't go stale.

const fs = require('fs');
const path = require('path');

// A `function` token and what stands right before it: `.` (a method of a class_), `::` (a namespace) or nothing
const FUNCTION_TOKEN = /(\.\s*|::\s*)?\bfunction\b/g;
const BINDINGS_BLOCK = /\bEMSCRIPTEN_BINDINGS\s*\(\s*\w+\s*\)\s*\{/g;
const BOUND_FUNCTION = /^&?\s*((?:\w+\s*::\s*)*\w+)$/;
// A policy is an object made with its default constructor, e.g. emscripten::allow_raw_pointers()
const POLICY = /^[\w:<>,\s]+\(\s*\)$/;

// The source without comments, with the strings kept (a comment could hold a signature that isn't one)
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (match) => (match[0] === '/' ? match.replace(/[^\n]/g, ' ') : match));
}

// The index after the string or character literal that starts at `i`, or `i` when none starts there
function skipLiteral(source, i) {
  const quote = source[i];
  if (quote !== '"' && quote !== "'") {
    return i;
  }
  let j = i + 1;
  while (j < source.length && source[j] !== quote && source[j] !== '\n') {
    j += source[j] === '\\' ? 2 : 1;
  }
  return j + 1;
}

// The index of the bracket that closes the one at `open` (`(` or `{`), outside literals, or -1
function closingBracket(source, open) {
  const opening = source[open];
  const closing = opening === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const after = skipLiteral(source, i);
    if (after !== i) {
      i = after - 1;
    } else if (source[i] === opening) {
      depth++;
    } else if (source[i] === closing && --depth === 0) {
      return i;
    }
  }
  return -1;
}

// The parts of a list (the text between its parentheses) at its commas outside <>, (), [], {} and literals, trimmed
function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const after = skipLiteral(list, i);
    if (after !== i) {
      i = after - 1;
      continue;
    }
    const ch = list[i];
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.replace(/\s+/g, ' ').trim());
}

// The number of parameters of a parameter list (the text between its parentheses): the commas outside <> and ()
function countParameters(list) {
  const text = list.replace(/\s+/g, ' ').trim();
  if (text === '' || text === 'void') {
    return 0;
  }
  return splitTopLevel(text).length;
}

// The bindings of free functions in a source without comments: [{ js, cpp, line }]. Throws for a binding that isn't in
// a form it reads.
function findBindings(source, file) {
  // The source with the insides of its literals blanked, so that a word or a bracket in a string is none
  const code = source.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (match) => match[0] + ' '.repeat(match.length - 2) + match[0]);
  const blocks = [];
  let block;
  BINDINGS_BLOCK.lastIndex = 0;
  while ((block = BINDINGS_BLOCK.exec(code)) !== null) {
    const open = block.index + block[0].length - 1;
    const close = closingBracket(code, open);
    blocks.push([open, close === -1 ? code.length : close]);
  }
  const inBlock = (index) => blocks.some(([open, close]) => index > open && index < close);
  const bindings = [];
  let token;
  FUNCTION_TOKEN.lastIndex = 0;
  while ((token = FUNCTION_TOKEN.exec(code)) !== null) {
    const prefix = (token[1] || '').trim();
    const at = token.index + (token[1] || '').length;
    const qualified = prefix === '::' && /\bemscripten\s*$/.test(code.slice(0, token.index));
    // A method of a class_, a name of another namespace (std::function), or a bare word outside the bindings
    if (prefix === '.' || (prefix === '::' && !qualified) || (prefix === '' && !inBlock(at))) {
      continue;
    }
    const where = `${file}:${code.slice(0, at).split('\n').length}`;
    const open = code.slice(at + 'function'.length).search(/\S/) + at + 'function'.length;
    if (code[open] !== '(') {
      throw new Error(`The Embind binding at ${where} can't be read: function is not followed by its arguments`);
    }
    const close = closingBracket(code, open);
    if (close === -1) {
      throw new Error(`The Embind binding at ${where} can't be read: its arguments don't end`);
    }
    const args = splitTopLevel(source.slice(open + 1, close));
    const name = /^"(\w+)"$/.exec(args[0]);
    const bound = args.length >= 2 ? BOUND_FUNCTION.exec(args[1]) : null;
    if (!name || !bound || !args.slice(2).every((policy) => POLICY.test(policy))) {
      throw new Error(`The Embind binding function(${args.join(', ')}) at ${where} can't be read: it must name the ` +
        'function in JavaScript, then its C++ function as &name or &namespace::name, then only policies');
    }
    bindings.push({ js: name[1], cpp: bound[1].replace(/\s+/g, ''), line: where });
    FUNCTION_TOKEN.lastIndex = close;
  }
  return bindings;
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
// (default: wasm/ of the repository). Throws when a binding can't be read, when a name is bound twice (Embind tells such
// overloads apart by their number of arguments, which one number per name can't describe) or when a bound function has
// no signature in the sources (a function named with its namespace is looked up as `ns::f(` and then as `f(`).
function readEmbindArity(repoRoot, folder) {
  const dir = folder || path.join(repoRoot, 'wasm');
  const files = fs.readdirSync(dir).filter((name) => /\.(cpp|hpp)$/.test(name)).sort();
  const read = (name) => ({ name, text: stripComments(fs.readFileSync(path.join(dir, name), 'utf8')) });
  // Declarations of the headers first, then the definitions
  const headers = files.filter((name) => /\.hpp$/.test(name)).map(read);
  const sources = files.filter((name) => /\.cpp$/.test(name)).map(read);
  const texts = headers.concat(sources).map((file) => file.text);
  const arity = {};
  const boundAt = {};
  headers.concat(sources).forEach((file) => {
    findBindings(file.text, file.name).forEach(({ js, cpp, line }) => {
      if (boundAt[js]) {
        throw new Error(`${js} is bound twice by Embind (${boundAt[js]} and ${line}), which the stub of the module can't model`);
      }
      boundAt[js] = line;
      const names = [cpp].concat(cpp.indexOf('::') >= 0 ? [cpp.slice(cpp.lastIndexOf('::') + 2)] : []);
      let list = null;
      for (const name of names) {
        for (const text of texts) {
          list = findParameterList(text, name);
          if (list !== null) {
            break;
          }
        }
        if (list !== null) {
          break;
        }
      }
      if (list === null) {
        throw new Error(`The signature of ${cpp}, which Embind binds as ${js}, was not found in ${dir}`);
      }
      arity[js] = countParameters(list);
    });
  });
  return arity;
}

module.exports = { readEmbindArity, countParameters, findParameterList, findBindings, stripComments };
