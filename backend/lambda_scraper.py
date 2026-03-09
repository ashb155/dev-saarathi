import json
import time
import boto3
import requests
from bs4 import BeautifulSoup

REGION = "ap-south-1"
BUCKET = "dev-saarathi-bucket"
KB_DOCS_PREFIX = "knowledge_base/docs/"
MODEL_ID = "apac.amazon.nova-pro-v1:0"

bedrock_client = boto3.client("bedrock-runtime", region_name=REGION)
s3_client = boto3.client("s3", region_name=REGION)


def decide_url_to_scrape(query):
    prompt = f"""A developer asked a question that wasn't found in our knowledge base:

"{query}"

Find the best documentation URL for this query. Follow this exact process:
1. Identify the technology/library being asked about
2. Find its OFFICIAL documentation site
3. Check if that site serves static HTML (not JavaScript-rendered)
4. If static → use it directly
5. If JS-rendered → find the raw GitHub markdown equivalent instead
6. Last resort → en.wikipedia.org/wiki/{{topic}}

Known static official doc sites (use these if relevant):
- developer.android.com — Android, Kotlin, Jetpack, ViewModel, LiveData, Compose
- raw.githubusercontent.com — any open source library on GitHub
- docs.python.org — Python
- developer.mozilla.org — Web, JavaScript, CSS, HTML
- readthedocs.io — Python ecosystem (Flask, Django, Celery, NumPy, Pandas etc.)
- git-scm.com — Git
- docs.docker.com — Docker
- kubernetes.io/docs — Kubernetes
- postgresql.org/docs — PostgreSQL
- mongodb.com/docs — MongoDB
- docs.aws.amazon.com — AWS services (S3, Lambda, Bedrock, EC2 etc.)
- developer.hashicorp.com — Terraform, Vault
- doc.rust-lang.org/book — Rust
- firebase.google.com/docs — Firebase (Authentication, Firestore, Realtime DB, Storage)
- cloud.google.com/docs — Google Cloud Platform (GCP, BigQuery, Cloud Run etc.)
- developers.google.com — Google APIs (Maps, OAuth, Workspace etc.)

Return a JSON object:
{{"url": "the best static documentation URL", "filename": "short_snake_case_name"}}
Only return the JSON, nothing else. Example:
{{"url": "https://developer.android.com/topic/libraries/architecture/viewmodel", "filename": "kotlin_viewmodel"}}"""

    response = bedrock_client.converse(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}]
    )
    text = response['output']['message']['content'][0]['text'].strip()
    text = text.replace("```json", "").replace("```", "").strip()
    return json.loads(text)


def scrape_page(url):
    """Scrape a static HTML or raw markdown page."""
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    response = requests.get(url, headers=headers, timeout=30)

    # If raw GitHub or plain text, return directly without HTML parsing
    if 'raw.githubusercontent.com' in url or 'text/plain' in response.headers.get('Content-Type', ''):
        lines = [line.strip() for line in response.text.splitlines() if line.strip()]
        return '\n'.join(lines)

    # Otherwise parse HTML
    soup = BeautifulSoup(response.text, 'html.parser')
    for tag in soup(['nav', 'footer', 'script', 'style', 'header', 'aside']):
        tag.decompose()

    main = (soup.find('main') or soup.find('article') or
            soup.find('div', class_='body') or
            soup.find('div', class_='content') or
            soup.find('div', id='content') or soup.body)

    text = main.get_text(separator='\n', strip=True) if main else soup.get_text(separator='\n', strip=True)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return '\n'.join(lines)


def lambda_handler(event, context):
    for record in event.get('Records', []):
        bucket = record['s3']['bucket']['name']
        miss_key = record['s3']['object']['key']

        print(f"Processing miss: {miss_key}")

        obj = s3_client.get_object(Bucket=bucket, Key=miss_key)
        query = obj['Body'].read().decode('utf-8').strip()
        print(f"Missed query: {query}")

        try:
            result = decide_url_to_scrape(query)
            url = result['url']
            filename = result['filename']
            print(f"Scraping: {url}")

            content = scrape_page(url)
            if not content or len(content) < 100:
                print(f"Scraped content too short or empty, skipping.")
                continue

            docs_key = f"{KB_DOCS_PREFIX}{filename}_{int(time.time())}.txt"
            s3_client.put_object(
                Bucket=BUCKET,
                Key=docs_key,
                Body=content.encode('utf-8'),
                ContentType='text/plain'
            )
            print(f"Scraped doc written: {docs_key}")

        except Exception as e:
            print(f"Scraper failed for query '{query}': {e}")
            continue

    return {"statusCode": 200, "body": "Scraper complete"}