'use strict';

// Lower-case the text and join words with a dash.
function slugify(text) {
  return String(text).toLowerCase().trim().replace(/ /g, '-');
}

module.exports = { slugify };
