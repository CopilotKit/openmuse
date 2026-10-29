// A match is rejected when the next character continues the numeric token
// (digit, a comma followed by a digit, a decimal dot followed by a digit) or
// attaches a magnitude/unit letter ($9M, $9k). A sentence comma, slash or
// other punctuation still ends the price.
const PRICE_PATTERN = /(?:\$|USD)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?!\d|[A-Za-z]|,\d|\.\d)/g;

export function matchesPrice(text: string, threshold: number): boolean {
  const matches = [...text.matchAll(PRICE_PATTERN)];
  return matches.some((m) => Number(m[1].replace(/,/g, "")) < threshold);
}
