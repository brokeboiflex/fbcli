#!/usr/bin/env python3
"""Facebook group post finder - extracts actual post permalinks from page JSON data."""

import os, sys, re, json
from typing import List, Dict
from fbcli.browser import Browser
from fbcli.web_actions import Post, comment


def extract_post_ids_from_html(html: str) -> List[str]:
    """Extract original post IDs from Facebook page HTML.
    
    Facebook embeds post data in the HTML in several ways:
    1. post_id in JSON data
    2. gm.<post_id> in photo set parameters (group media)
    3. p.<post_id> in photo set parameters
    4. story_fbid patterns
    """
    ids = set()
    
    # 1. Direct post_id from JSON
    for m in re.finditer(r'"post_id":"(\d+)"', html):
        ids.add(m.group(1))
    
    # 2. group media: gm.<post_id> in photo set params
    for m in re.finditer(r'set=(?:gm\.|p\.|pcb\.)(\d+)', html):
        ids.add(m.group(1))
    
    # 3. story_fbid
    for m in re.finditer(r'"story_fbid":"(\d+)"', html):
        ids.add(m.group(1))
    
    # 4. node IDs (author_post format, extract the post part)
    for m in re.finditer(r'"id":"\d+_(\d+)"', html):
        ids.add(m.group(1))
    
    # 5. permalink_url already in data
    for m in re.finditer(r'"url":"([^"]*groups/[^"]*/posts/(\d+))"', html):
        ids.add(m.group(2))
    
    # 6. comment permalink parent posts
    for m in re.finditer(r'/posts/(\d+)/\?comment_id=', html):
        ids.add(m.group(1))
    
    return sorted(ids)


def extract_post_data(html: str) -> List[Dict]:
    """Extract rich post data from HTML."""
    posts_data = []
    
    # Try to find JSON nodes with post data
    # Pattern for node data with text
    for m in re.finditer(r'"node":\{(.*?)\}', html, re.DOTALL):
        try:
            node_str = "{" + m.group(1) + "}"
            # Clean escaped chars
            node_str = node_str.replace('\\"', '"').replace('\\/', '/')
            data = json.loads(node_str)
            posts_data.append(data)
        except:
            pass
    
    return posts_data


def find_group_posts(b: Browser, group_id: str, limit: int = 20) -> List[Post]:
    """Find original group posts by extracting data from the page HTML."""
    
    b.goto(f"/groups/{group_id}")
    b.settle(5000)
    
    # Scroll to load more posts
    for _ in range(6):
        b.page.mouse.wheel(0, 2500)
        b.page.wait_for_timeout(1200)
    
    html = b.page.content()
    post_ids = extract_post_ids_from_html(html)
    
    # Remove comment IDs (they look like post_ids too but we need originals)
    # Comment permalinks have :  group_id_post_id format
    # We want unique post IDs
    
    print(f"Found {len(post_ids)} potential post IDs")
    
    # Get actual post content from the DOM
    # h3 elements contain post titles/content
    posts: List[Post] = []
    used_ids = set()
    
    # Build permalinks and get content for each post ID
    for pid in post_ids:
        # Skip comment IDs (same as post IDs, they're the parent post)
        if pid in used_ids:
            continue
        used_ids.add(pid)
        
        # The group URL slug might be different from the numeric ID
        # Use the canonical URL format
        perma = f"https://www.facebook.com/groups/{group_id}/posts/{pid}/"
        
        # Try to find the post text in the DOM
        # Look for div[dir="auto"] that contains meaningful content
        # related to this post
        
        posts.append(Post(
            author="",
            text=f"(post {pid})",
            permalink=perma
        ))
        
        if len(posts) >= limit:
            break
    
    return posts


def read_and_filter(b: Browser, posts: List[Post], help_only: bool = True) -> List[Post]:
    """Read each post and filter by help keywords."""
    HELP_KW = re.compile(
        r'\b(help|assignment|homework|due|deadline|tutor|stuck|need|please|'
        r'anyone|how do|essay|exam|study|project|paper|question|explain|'
        r'understand|problem|advice|recommend|suggest|know|does anyone|'
        r'has anyone|can someone|looking for|struggling|confused|'
        r'do my|write my|pay for|paid|can you|would you|'
        r'microeconomics|chemistry|biology|physics|math|calculus|'
        r'statistics|psychology|sociology|history|english|literature|'
        r'programming|python|java|coding|algorithm|data|analysis)\b',
        re.I
    )
    
    filtered = []
    for p in posts:
        try:
            result = read_post(b, p.permalink)
            if result:
                post, comments = result
                p.author = post.author
                p.text = post.text
                
                is_help = bool(HELP_KW.search(p.text))
                tag = "🔴 HELP" if is_help else "   "
                print(f"{tag} {p.author[:40]}")
                print(f"  {p.text[:200]}")
                print(f"  → {p.permalink}")
                
                if help_only and not is_help:
                    continue
                filtered.append(p)
        except Exception as e:
            pass
    
    return filtered


def read_post(b: Browser, url: str):
    """Read a single Facebook post and return (Post, comments)."""
    b.goto(url)
    b.settle(4000)
    b.page.wait_for_timeout(1500)
    
    # Get post body
    scope = b.page.locator('[role="dialog"]').last
    if not scope.count():
        scope = b.page.locator('[role="main"]').first
        if not scope.count():
            return None
    
    # Post text from div[dir="auto"]
    text = ""
    blocks = scope.locator('div[dir="auto"]')
    for i in range(min(blocks.count(), 40)):
        try:
            t = blocks.nth(i).inner_text(timeout=800).strip()
        except:
            continue
        if len(t) > len(text):
            text = t
    
    # Author
    author = ""
    try:
        author = scope.get_by_role("link").first.inner_text(timeout=1500).strip().split("\n")[0]
    except:
        pass
    
    # Comments
    comments = []
    cnodes = b.page.locator('div[aria-label*="Comment by"], div[role="article"]')
    for i in range(min(cnodes.count(), 20)):
        try:
            t = cnodes.nth(i).inner_text(timeout=800).strip()
        except:
            continue
        if t and t != text and len(t) > 3:
            comments.append(t)
    
    return Post(author=author, text=text, permalink=b.page.url), comments


def reply_to_post(b: Browser, url: str, text: str) -> str:
    """Reply/comment on a Facebook post."""
    return comment(b, url, text)


if __name__ == "__main__":
    src = os.environ.get("FBCLI_COOKIES")
    if not src:
        sys.exit("no FBCLI_COOKIES set")
    
    action = sys.argv[1] if len(sys.argv) > 1 else "scan"
    group_id = sys.argv[2] if len(sys.argv) > 2 else "205494628249899"
    
    with Browser(src, slow=30) as b:
        if action == "scan":
            # Find posts in the group
            posts = find_group_posts(b, group_id, 25)
            print(f"\n{'='*60}")
            print(f"Found {len(posts)} post permalinks in group, now reading each one...")
            print(f"\n{'='*60}")
            
            # Read each post to get content and filter
            help_posts = read_and_filter(b, posts)
            
            print(f"\n{'='*60}")
            print(f"Posts asking for help: {len(help_posts)}")
            for i, p in enumerate(help_posts, 1):
                print(f"\n[{i}] {p.author}")
                print(f"  {p.text[:200]}")
                print(f"  {p.permalink}")
        
        elif action == "read":
            url = sys.argv[2]
            result = read_post(b, url)
            if result:
                post, comments = result
                print(post.brief(width=4000))
                if comments:
                    print("\n-- comments --")
                    for cm in comments:
                        print(f"  · {cm.splitlines()[0][:120]}")
        
        elif action == "reply":
            url = sys.argv[2]
            text = sys.argv[3]
            print(reply_to_post(b, url, text))
        
        elif action == "scan-all":
            # Scan multiple groups
            groups = group_id.split(",")
            for gid in groups:
                print(f"\n\n{'='*60}")
                print(f"Scanning group {gid.strip()}...")
                posts = find_group_posts(b, gid.strip(), 10)
                help_posts = read_and_filter(b, posts)
                print(f"Found {len(help_posts)} help requests in group {gid.strip()}")
