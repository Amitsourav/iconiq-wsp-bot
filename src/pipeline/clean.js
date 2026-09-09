/**
 * Line cleaning, shared by everything that reads a message.
 *
 * People write leads as bullet lists. WhatsApp renders those with a bullet
 * character AND invisible joiners around it, so a line that looks like
 * "Student : Nihal" actually begins with "•⁠  ⁠". Every label rule then
 * fails to match, and any value that does get through carries the junk into the
 * CRM.
 */

/** Zero-width and invisible characters WhatsApp scatters through bullet lists. */
const INVISIBLE = /[​-‍⁠﻿  ]/g;

/** Bullet and list markers people open a line with. */
const BULLET = /^[\s•‣▪●◦⁃∙*·◦▪▫●○►▶→\-–—]+/;

/**
 * Strip invisible characters and any leading bullet from a line.
 *
 * Note the order: invisibles first, because a bullet is often separated from the
 * text by them and would otherwise survive.
 *
 * @param {string} line
 * @returns {string}
 */
function cleanLine(line) {
  return String(line ?? '')
    .replace(INVISIBLE, ' ')
    .replace(BULLET, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Clean every line of a message, dropping the blanks.
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  return String(text ?? '')
    .split('\n')
    .map(cleanLine)
    .join('\n');
}

module.exports = { cleanLine, cleanText, INVISIBLE, BULLET };
