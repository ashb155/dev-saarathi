import json
import uuid
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

REGION = "ap-south-1"
JOBS_TABLE = "dev-saarathi-jobs"
USERS_TABLE = "dev-saarathi-users"
PROCESSOR_FUNCTION = "dev-saarathi-processor"

dynamodb = boto3.resource("dynamodb", region_name=REGION)
lambda_client = boto3.client("lambda", region_name=REGION)


def lambda_handler(event, context):
    try:
        body = json.loads(event.get('body', '{}'))
        audio_base64 = body.get('audio')
        user_id = body.get('user_id', 'anonymous')
        code_context = body.get('code_context')
        active_filename = body.get('active_filename')

        if not audio_base64:
            return response(400, {"error": "No audio provided"})

        job_id = str(uuid.uuid4())
        timestamp = datetime.now(timezone.utc).isoformat()

        dynamodb.Table(JOBS_TABLE).put_item(Item={
            'job_id': job_id,
            'user_id': user_id,
            'status': 'PROCESSING',
            'timestamp': timestamp,
            'query': '',
            'response': '',
            'intent': '',
            'detected_lang': ''
        })

        try:
            dynamodb.Table(USERS_TABLE).put_item(
                Item={
                    'user_id': user_id,
                    'created_at': timestamp,
                    'last_seen': timestamp,
                    'preferred_lang': '',
                    'total_queries': 0
                },
                ConditionExpression='attribute_not_exists(user_id)'
            )
        except ClientError as e:
            if e.response['Error']['Code'] != 'ConditionalCheckFailedException':
                raise

        try:
            dynamodb.Table(USERS_TABLE).update_item(
                Key={'user_id': user_id},
                UpdateExpression='SET last_seen = :ts ADD total_queries :inc',
                ExpressionAttributeValues={':ts': timestamp, ':inc': 1}
            )
        except Exception as e:
            print(f"Failed to update user: {e}")

        payload = {
            'job_id': job_id,
            'user_id': user_id,
            'audio_base64': audio_base64,
            'timestamp': timestamp
        }
        if code_context:
            payload['code_context'] = code_context
        if active_filename:
            payload['active_filename'] = active_filename

        lambda_client.invoke(
            FunctionName=PROCESSOR_FUNCTION,
            InvocationType='Event',
            Payload=json.dumps(payload)
        )

        print(f"Job created: {job_id} for user: {user_id}")
        return response(200, {"job_id": job_id, "status": "PROCESSING"})

    except Exception as e:
        print(f"Trigger error: {e}")
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