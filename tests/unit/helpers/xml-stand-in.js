'use strict';

// A stand-in for the XML parser of the page, for the unit tests of wasm/static/js/utils.js, which have neither jQuery
// nor a DOM: installXmlStandIn(platform) gives the context a `$` and an NvHTTP.prototype._parseXML() that read the
// answers of a host (server info, app list) the way the app reads them:
//  - like jQuery: $xml.find(name), .attr(name) of the first element, .text() of all of them, .slice(), .each() with
//    $(element) inside, .html(), [index] and .length;
//  - like the DOM: element.getElementsByTagName(name) and element.textContent.
// It knows elements, attributes in double quotes, text and the five entities of XML, which is what the hosts send; the
// browser tests run the same code with the real parser.

const SOURCE = `(function() {
  var decode = function(text) {
    return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  };

  function Element(name, attributes) {
    this.tagName = name;
    this.attributes = attributes;
    // The child elements and the texts between them, in order
    this.parts = [];
  }
  Object.defineProperty(Element.prototype, 'textContent', {
    get: function() {
      return this.parts.map(function(part) {
        return typeof part === 'string' ? part : part.textContent;
      }).join('');
    },
  });
  Element.prototype.getElementsByTagName = function(name) {
    var found = [];
    this.parts.forEach(function(part) {
      if (typeof part !== 'string') {
        if (part.tagName === name) {
          found.push(part);
        }
        found = found.concat(part.getElementsByTagName(name));
      }
    });
    return found;
  };

  var parse = function(xml) {
    var token = /<\\?[^>]*\\?>|<!--[\\s\\S]*?-->|<\\/([\\w:-]+)\\s*>|<([\\w:-]+)((?:\\s+[\\w:-]+="[^"]*")*)\\s*(\\/?)>|([^<]+)/g;
    var documentElement = new Element('#document', {});
    var open = [documentElement];
    var match;
    while ((match = token.exec(xml)) !== null) {
      var top = open[open.length - 1];
      if (match[1]) {
        if (open.length > 1) {
          open.pop();
        }
      } else if (match[2]) {
        var attributes = {};
        (match[3].match(/[\\w:-]+="[^"]*"/g) || []).forEach(function(attribute) {
          attributes[attribute.slice(0, attribute.indexOf('='))] = decode(attribute.slice(attribute.indexOf('=') + 2, -1));
        });
        var element = new Element(match[2], attributes);
        top.parts.push(element);
        if (!match[4]) {
          open.push(element);
        }
      } else if (match[5]) {
        top.parts.push(decode(match[5]));
      }
    }
    return documentElement;
  };

  var collection = function(elements) {
    var result = {
      length: elements.length,
      attr: function(name) {
        return elements.length > 0 ? elements[0].attributes[name] : undefined;
      },
      find: function(name) {
        var found = [];
        elements.forEach(function(element) {
          found = found.concat(element.getElementsByTagName(name));
        });
        return collection(found);
      },
      text: function() {
        return elements.map(function(element) { return element.textContent; }).join('');
      },
      html: function() {
        return elements.length > 0 ? elements[0].textContent : undefined;
      },
      slice: function(start, end) {
        return collection(elements.slice(start, end));
      },
      each: function(callback) {
        elements.forEach(function(element, index) {
          callback.call(element, index, element);
        });
        return result;
      },
    };
    elements.forEach(function(element, index) {
      result[index] = element;
    });
    return result;
  };

  window.$ = function(element) {
    return collection([element]);
  };
  NvHTTP.prototype._parseXML = function(xml) {
    return collection([parse(String(xml))]);
  };
})();`;

// Give the context of a platform (helpers/platform-loader.js) that loaded utils.js the stand-in
function installXmlStandIn(platform) {
  platform.run(SOURCE);
  return platform;
}

// A text as the content of an XML element
function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { escapeXml, installXmlStandIn };
