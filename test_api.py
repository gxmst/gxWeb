import requests
import feedparser

def test_rss():
    url = "https://cn.wsj.com/zh-hans/rss"
    # 必须伪装成真实的浏览器
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
    
    print(f"正在抓取 {url} ...")
    try:
        # 1. 用 requests 强行把 XML 文本扒下来
        resp = requests.get(url, headers=headers, timeout=10)
        print(f"网络状态码: {resp.status_code}")
        
        if resp.status_code == 200:
            # 2. 把扒下来的纯文本喂给 feedparser
            feed = feedparser.parse(resp.text)
            entries = feed.entries
            print(f"成功解析出 {len(entries)} 篇文章！")
            
            if len(entries) > 0:
                print("\n第一篇文章演示:")
                print("标题:", entries[0].get('title', '无标题'))
                print("链接:", entries[0].get('link', '无链接'))
        else:
            print("抓取失败，可能被墙或被反爬拦截。")
            
    except Exception as e:
        print("发生异常:", e)

if __name__ == "__main__":
    test_rss()