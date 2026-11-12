/**
 * Parsed RSS item representation.
 */
export interface RssFeedItem {
  readonly title: string;
  readonly link: string;
  readonly description?: string;
  readonly pubDate?: string;
  readonly guid?: string;
  readonly contentEncoded?: string;
}

/**
 * Strips CDATA markers and decodes basic XML entities.
 */
function cleanXmlText(text: string): string {
  const cleaned = text.trim();

  // Strip CDATA wrappers if present: <![CDATA[...]]>
  const cdataMatch = cleaned.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdataMatch?.[1] !== undefined) {
    return cdataMatch[1].trim();
  }

  return cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Extracts inner content of the first matching XML tag.
 */
function extractTagContent(xml: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  if (!match?.[1]) {
    return undefined;
  }
  return cleanXmlText(match[1]);
}

/**
 * Parses RSS 2.0 XML string into strongly-typed feed items.
 */
export function parseRssFeed(xml: string): readonly RssFeedItem[] {
  const itemMatches = xml.match(/<item(?:\s+[^>]*)?>([\s\S]*?)<\/item>/gi) ?? [];
  const items: RssFeedItem[] = [];

  for (const itemXml of itemMatches) {
    const title = extractTagContent(itemXml, 'title') ?? '';
    const link = extractTagContent(itemXml, 'link') ?? '';
    const description = extractTagContent(itemXml, 'description');
    const pubDate = extractTagContent(itemXml, 'pubDate');
    const guid = extractTagContent(itemXml, 'guid');
    const contentEncoded =
      extractTagContent(itemXml, 'content:encoded') ?? extractTagContent(itemXml, 'encoded');

    if (title && link) {
      items.push({
        title,
        link,
        description,
        pubDate,
        guid,
        contentEncoded,
      });
    }
  }

  return items;
}
