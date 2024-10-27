import { Notice, requestUrl } from 'obsidian'
import { domain } from 'process'

function blank(text: string): boolean {
  return text === undefined || text === null || text === ''
}

function notBlank(text: string): boolean {
  return !blank(text)
}

async function scrape(url: string): Promise<string> {
  try {
    const response = await requestUrl(url)
    if (!response.headers['content-type'].includes('text/html')) return getUrlFinalSegment(url)
    const html = response.text

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const title = doc.querySelector('title')

    if (blank(title?.innerText)) {
      // If site is javascript based and has a no-title attribute when unloaded, use it.
      var noTitle = title?.getAttr('no-title')
      if (notBlank(noTitle)) {
        return noTitle
      }

      // Otherwise if the site has no title/requires javascript simply return Title Unknown
      return url
    }

    return title.innerText
  } catch (ex) {
    console.error(ex)
    return 'Site Unreachable'
  }
}

export function getFaviconElement(url: string): string {
  const domain = new URL(url).hostname.replace('www.', '');
  return `<img width=16 height=16 src='http://www.google.com/s2/favicons?domain=${domain}'/>`;
}


export async function scrapeFirstURL(api : string, cx : string, query: string): Promise<string> {
  let url : string;
  const api_url = "https://www.googleapis.com/customsearch/v1?"

  const params = {
    key: api,
    cx: cx,
    q: query,
    num: "1"
  }

  const searchParams = new URLSearchParams(params);

  let response = await requestUrl(api_url + searchParams.toString())

  if (response.status == 200) {
    let data = response.json
    url = data.items[0].link
    new Notice("keyword: " + query + "\nfetched URL: " + url)
  } else {
    console.error("Error fetching data from Google Custom Search API")
    return "Error"
  }

  return url
}

function getUrlFinalSegment(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/')
    const last = segments.pop() || segments.pop() // Handle potential trailing slash
    return last
  } catch (_) {
    return 'File'
  }
}

export default async function getPageTitle(url: string) {
  if (!(url.startsWith('http') || url.startsWith('https'))) {
    url = 'https://' + url
  }

  return scrape(url)
}
