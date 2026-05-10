"""AO3 读后感 - 后端 API
直接抓取 AO3 作品页面 HTML，解析后返回 JSON。
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
    'User-Agent': 'Mozilla/5.0 (compatible; AO3Reader/1.0; +https://ao3-reader.onrender.com)',
}


def extract_work_id(url):
    """从 AO3 URL 中提取数字 work ID"""
    match = re.search(r'/works/(\d+)', url)
    return int(match.group(1)) if match else None


def text(el):
    """安全获取元素文本"""
    return el.get_text(strip=True) if el else ''


def texts(elements):
    """获取元素列表的文本"""
    return [el.get_text(strip=True) for el in elements]


def parse_ao3_page(html, ao3_url):
    """解析 AO3 作品页面 HTML，提取元数据"""
    soup = BeautifulSoup(html, 'html.parser')
    work = soup.find('div', class_='wrapper') or soup

    # === 标题 ===
    title_el = work.select_one('h2.title.heading') or work.select_one('h2.heading')
    title = title_el.get_text(strip=True) if title_el else ''
    # 去掉标题后面可能包含的作者名 "Title - Author"
    # AO3 标题格式: "Title by Author"
    # 我们用 h2.heading > a 可能更好
    title_link = work.select_one('h2.title.heading a') or work.select_one('h2.heading a')
    title = title_link.get_text(strip=True) if title_link else title

    # === 作者 ===
    author_el = work.select_one('a[rel="author"]')
    author = author_el.get_text(strip=True) if author_el else ''

    # === 同人圈 ===
    fandom = texts(work.select('dd.fandom.tags a.tag'))

    # === 关系 / CP ===
    relationships = texts(work.select('dd.relationship.tags a.tag'))

    # === 角色 ===
    characters = texts(work.select('dd.character.tags a.tag'))

    # === 自由标签 ===
    freeform_tags = texts(work.select('dd.freeform.tags a.tag'))

    # === 评级 ===
    rating_el = work.select_one('dd.rating.tags a.tag') or work.select_one('dd.rating')
    rating = rating_el.get_text(strip=True) if rating_el else ''

    # === 警告 ===
    warnings = texts(work.select('dd.warning.tags a.tag'))

    # === 类别 ===
    categories = texts(work.select('dd.category.tags a.tag'))
    category = categories[0] if categories else ''

    # === 摘要 ===
    summary_el = work.select_one('blockquote.userstuff.summary')
    summary = summary_el.get_text(strip=True) if summary_el else ''

    # === 字数 ===
    words_el = work.select_one('dd.words')
    word_count = words_el.get_text(strip=True) if words_el else ''

    # === 章节 ===
    chapters_el = work.select_one('dd.chapters')
    chapters = chapters_el.get_text(strip=True) if chapters_el else ''

    # === 语言 ===
    lang_el = work.select_one('dd.language')
    language = lang_el.get_text(strip=True) if lang_el else ''

    # === 发布日期 ===
    pub_el = work.select_one('dd.published')
    published = pub_el.get_text(strip=True) if pub_el else ''

    # === 完结状态 ===
    status_el = work.select_one('dd.status')
    status = status_el.get_text(strip=True) if status_el else ''
    # 从章节信息推断
    if not status and chapters:
        parts = chapters.split('/')
        if len(parts) == 2:
            if parts[0] == parts[1]:
                status = 'Completed' if parts[0] != '1' else 'Completed'
            else:
                status = 'In Progress'

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


@app.route('/api/fetch')
def fetch_work():
    """获取 AO3 作品信息
    GET /api/fetch?url=https://archiveofourown.org/works/12345
    """
    url = request.args.get('url', '').strip()
    if not url:
        return jsonify({'ok': False, 'error': '缺少 url 参数'}), 400

    work_id = extract_work_id(url)
    if not work_id:
        return jsonify({'ok': False, 'error': '无法从 URL 提取作品 ID，请检查链接格式'}), 400

    logger.info(f'Fetching work {work_id}')

    try:
        resp = requests.get(url, headers=HEADERS, timeout=20)
        resp.raise_for_status()

        if resp.status_code != 200:
            return jsonify({'ok': False, 'error': f'AO3 返回状态码 {resp.status_code}'}), 502

        data = parse_ao3_page(resp.text, url)

        if not data['title'] and not data['author']:
            return jsonify({'ok': False, 'error': '无法解析页面内容，作品可能已被删除或需要登录'}), 404

        logger.info(f'Success: "{data["title"]}" by {data["author"]}')
        return jsonify({'ok': True, 'data': data})

    except requests.Timeout:
        logger.error(f'Timeout fetching work {work_id}')
        return jsonify({'ok': False, 'error': '请求 AO3 超时，请稍后重试'}), 504
    except requests.RequestException as e:
        logger.error(f'Network error fetching work {work_id}: {e}')
        return jsonify({'ok': False, 'error': f'网络请求失败: {str(e)}'}), 502
    except Exception as e:
        logger.error(f'Unexpected error for work {work_id}: {e}')
        return jsonify({'ok': False, 'error': f'解析失败: {str(e)}'}), 500


@app.route('/api/health')
def health():
    """健康检查"""
    return jsonify({'ok': True, 'status': 'running'})


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
