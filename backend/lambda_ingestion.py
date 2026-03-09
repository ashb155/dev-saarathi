import boto3
import uuid

REGION = "ap-south-1"
KNOWLEDGE_BASE_ID = "NVPLYO2YFI"
DATA_SOURCE_ID = "PVE7306WKJ"

bedrock_agent_client = boto3.client("bedrock-agent", region_name=REGION)


def lambda_handler(event, context):
    """
    Fired by S3 event when a .txt lands in knowledge_base/docs/.
    Starts a Bedrock ingestion job to sync the new doc into the KB.
    """
    for record in event.get('Records', []):
        docs_key = record['s3']['object']['key']
        print(f"New doc detected: {docs_key} — starting ingestion job...")

        try:
            response = bedrock_agent_client.start_ingestion_job(
                knowledgeBaseId=KNOWLEDGE_BASE_ID,
                dataSourceId=DATA_SOURCE_ID,
                clientToken=str(uuid.uuid4()),  # 36 chars, always valid
                description=f"Auto-sync triggered by {docs_key}"
            )
            job_id = response['ingestionJob']['ingestionJobId']
            print(f"Ingestion job started: {job_id}")

        except bedrock_agent_client.exceptions.ConflictException:
            print("Ingestion job already in progress, new doc will be included in next sync.")

        except Exception as e:
            print(f"Failed to start ingestion job for {docs_key}: {e}")
            raise

    return {"statusCode": 200, "body": "Ingestion triggered"}