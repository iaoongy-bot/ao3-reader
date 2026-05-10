"""AO3 读后感 - 后端 API
多级策略获取 AO3 作品页面：直接请求 → Cloudscraper → CORS 代理。
部署于 Render.com 免费 tier。
"""

import re
import logging
import requests
from bs4 import BeautifulSoup
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Sec-Ch-Ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
}

CORS_PROXIES = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
]


def extract_work_id(url):
    match = re.search(r'/works/(\d+)', url)
    return int(match.group(1)) if match else None


def texts(elements):
    return [el.get_text(strip=True) for el in elements]


def parse_ao3_page(html, ao3_url):
    soup = BeautifulSoup(html, 'html.parser')

    # 标题 — 优先找链接内的文字，否则直接取 heading 文字
    title_el = soup.select_one('h2.title.heading a') or soup.select_one('h2.title.heading') or soup.select_one('h2.heading')
    title = title_el.get_text(strip=True) if title_el else ''

    # 作者
    author_el = soup.select_one('a[rel="author"]')
    author = author_el.get_text(strip=True) if author_el else ''

    # 同人圈 / 关系 / 角色 / 自由标签
    fandom = texts(soup.select('dd.fandom.tags a.tag'))
    relationships = texts(soup.select('dd.relationship.tags a.tag'))
    characters = texts(soup.select('dd.character.tags a.tag'))
    freeform_tags = texts(soup.select('dd.freeform.tags a.tag'))

    # 评级 / 警告 / 类别
    rating_el = soup.select_one('dd.rating.tags a.tag') or soup.select_one('dd.rating')
    rating = rating_el.get_text(strip=True) if rating_el else ''
    warnings = texts(soup.select('dd.warning.tags a.tag'))
    cats = texts(soup.select('dd.category.tags a.tag'))
    category = cats[0] if cats else ''

    # 摘要
    summary_el = soup.select_one('blockquote.userstuff.summary')
    summary = summary_el.get_text(strip=True) if summary_el else ''

    # 字数 / 章节 / 语言 / 发布 / 状态
    word_count = _dd_text(soup, 'dd.words')
    chapters = _dd_text(soup, 'dd.chapters')
    language = _dd_text(soup, 'dd.language')
    published = _dd_text(soup, 'dd.published')
    status = _dd_text(soup, 'dd.status')

    # 从章节推断状态
    if not status and chapters:
        parts = chapters.split('/')
        if len(parts) == 2:
            status = 'Completed' if parts[0] == parts[1] else 'In Progress'

    return {
        'title': title,
        'author': author,
        'fandom': fandom,
        'relationships': relationships,
        'characters': characters,
        'freeformTags': freeform_tags,
        'rating': rating,
        'warnings': warnings,
        'category': category,
        'summary': summary,
        'wordCount': word_count,
        'chapters': chapters,
        'status': status,
        'language': language,
        'published': published,
        'ao3Url': ao3_url,
    }


def _dd_text(soup, selector):
    el = soup.select_one(selector)
    return el.get_text(strip=True) if el else ''


def fetch_direct(url):
    """策略 1: 直接请求 AO3"""
    resp = requests.get(url, headers=HEADERS, timeout=25)
    if resp.status_code == 200:
        return resp.text
    raise Exception(f'HTTP {resp.status_code}')


def fetch_cloudscraper(url):
    """策略 2: 使用 cloudscraper 绕过 Cloudflare"""
    try:
        import cloudscraper
        scraper = cloudscraper.create_scraper()
        resp = scraper.get(url, timeout=30)
        if resp.status_code == 200:
            return resp.text
        raise Exception(f'Cloudscraper HTTP {resp.status_code}')
    except ImportError:
        raise Exception('cloudscraper 未安装')
    except Exception as e:
        raise Exception(f'Cloudscraper 失败: {str(e)}')


def fetch_via_proxy(url):
    """策略 3: 通过 CORS 代理获取"""
    for proxy in CORS_PROXIES:
        try:
            resp = requests.get(proxy + url, timeout=25)
            if resp.status_code == 200 and resp.text:
                return resp.text
        except Exception:
            continue
    raise Exception('所有代理均不可用')


@app.route('/api/fetch')
def fetch_work():
    url = request.args.get('url', '').strip()
    if not url:
        return jsonify({'ok': False, 'error': '缺少 url 参数'}), 400

    work_id = extract_work_id(url)
    if not work_id:
        return jsonify({'ok': False, 'error': '无法从 URL 提取作品 ID'}), 400

    logger.info(f'Fetching work {work_id}')

    html = None
    errors = []

    # 依次尝试三种策略
    for name, fetcher in [
        ('direct', fetch_direct),
        ('cloudscraper', fetch_cloudscraper),
        ('proxy', fetch_via_proxy),
    ]:
        try:
            logger.info(f'Trying strategy: {name}')
            html = fetcher(url)
            logger.info(f'Strategy {name} succeeded')
            break
        except Exception as e:
            errors.append(f'{name}: {e}')
            logger.warning(f'Strategy {name} failed: {e}')

    if not html:
        return jsonify({
            'ok': False,
            'error': f'所有获取方式均失败: {"; ".join(errors)}',
        }), 502

    try:
        data = parse_ao3_page(html, url)
        if not data['title'] and not data['author']:
            return jsonify({'ok': False, 'error': '无法解析页面内容，作品可能已删除或需要登录'}), 404
        logger.info(f'Success: "{data["title"]}" by {data["author"]}')
        return jsonify({'ok': True, 'data': data})
    except Exception as e:
        logger.error(f'Parse error: {e}')
        return jsonify({'ok': False, 'error': f'解析失败: {str(e)}'}), 500


@app.route('/api/health')
def health():
    return jsonify({'ok': True, 'status': 'running'})


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
