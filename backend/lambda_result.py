
import json
import re
import boto3
from boto3.dynamodb.conditions import Key

REGION = "ap-south-1"
JOBS_TABLE = "dev-saarathi-jobs"
HISTORY_TABLE = "dev-saarathi-history"
USERS_TABLE = "dev-saarathi-users"

dynamodb = boto3.resource("dynamodb", region_name=REGION)


def extract_code_block(response_text):
    """Extract code from the first ```lang ... ``` block."""
    match = re.search(r'```(?:\w+)?\n(.*?)```', response_text, re.DOTALL)
    return match.group(1).strip() if match else ""


def lambda_handler(event, context):
    try:
        path = event.get('path', '') or event.get('rawPath', '')
        path_params = event.get('pathParameters') or {}

        # ── GET /result/{job_id} ───────────────────────────────────────────────
        if 'job_id' in path_params:
            job_id = path_params['job_id']
            if not job_id:
                return response(400, {"error": "job_id is required"})

            result = dynamodb.Table(JOBS_TABLE).get_item(Key={'job_id': job_id})
            item = result.get('Item')

            if not item:
                return response(404, {"error": "Job not found"})

            status = item.get('status', 'PROCESSING')

            if status == 'PROCESSING':
                return response(200, {
                    "job_id": job_id,
                    "status": "PROCESSING"
                })

            elif status == 'COMPLETED':
                response_text = item.get('response', '')
                return response(200, {
                    "job_id": job_id,
                    "status": "COMPLETED",
                    "query": item.get('query', ''),
                    "response": response_text,
                    "intent": item.get('intent', ''),
                    "detected_lang": item.get('detected_lang', ''),
                    "agentic_file": item.get('agentic_file', ''),
                    "proposed_code": extract_code_block(response_text)
                })

            elif status == 'FAILED':
                return response(200, {
                    "job_id": job_id,
                    "status": "FAILED",
                    "error": item.get('response', 'Processing failed')
                })

        # ── GET /history/{user_id} ─────────────────────────────────────────────
        elif 'user_id' in path_params:
            user_id = path_params['user_id']
            if not user_id:
                return response(400, {"error": "user_id is required"})

            result = dynamodb.Table(HISTORY_TABLE).query(
                KeyConditionExpression=Key('user_id').eq(user_id),
                ScanIndexForward=False,
                Limit=10
            )
            items = result.get('Items', [])

            user_result = dynamodb.Table(USERS_TABLE).get_item(Key={'user_id': user_id})
            user = user_result.get('Item', {})

            return response(200, {
                "user_id": user_id,
                "preferred_lang": user.get('preferred_lang', ''),
                "total_queries": int(user.get('total_queries', 0)),
                "last_seen": user.get('last_seen', ''),
                "history": [
                    {
                        "timestamp": item.get('timestamp', ''),
                        "query": item.get('query', ''),
                        "response": item.get('response', ''),
                        "intent": item.get('intent', ''),
                        "detected_lang": item.get('detected_lang', '')
                    }
                    for item in items
                ]
            })

        else:
            return response(400, {"error": "Invalid path. Use /result/{job_id} or /history/{user_id}"})

    except Exception as e:
        print(f"Result Lambda error: {e}")
        return response(500, {"error": str(e)})


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        "body": json.dumps(body)
    }