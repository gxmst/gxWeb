import requests

def test_sina_hq():
    url = "https://hq.sinajs.cn/list=s_sh000001,gb_dji,gb_ixic,gb_nvda,hf_GC,hf_SI,hf_HG,hf_CL,fx_susdcny,fx_susdjpy,b_N225,b_KS11,int_nikkei"
    headers = {"Referer": "https://finance.sina.com.cn/"}
    
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        # 打印出新浪返回的极其原始的字符串
        lines = resp.text.strip().split(';')
        for line in lines:
            if line:
                print(line)
    except Exception as e:
        print("报错:", e)

if __name__ == "__main__":
    test_sina_hq()