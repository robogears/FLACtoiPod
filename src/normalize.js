const path = require('path');

// Strip extension, lowercase, remove parentheticals,
// drop non-word chars (preserving underscores + whitespace, Unicode-aware),
// underscores → spaces, collapse whitespace.
function normalize(s) {
  let result = path.parse(s).name.toLowerCase();
  result = result.replace(/\s*[\(\[].+?[\)\]]/g, '');
  result = result.replace(/[^\p{L}\p{N}_\s]/gu, '');
  result = result.replace(/_/g, ' ');
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}

// Remove leading "01 - " track numbers and artist prefix, normalize the rest.
function stripArtistPrefix(s) {
  let result = path.parse(s).name;
  result = result.replace(/^\d+\s*[-–]\s*/, '');
  const parts = result.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return normalize(parts[parts.length - 1]);
  }
  return normalize(result);
}

module.exports = { normalize, stripArtistPrefix };
