"""S3イベントでデータソース同期を自動実行する。"""

import os

import boto3

client = boto3.client("bedrock-agent", region_name=os.environ["REGION"])


def lambda_handler(event: dict, context: object) -> None:
    """S3イベントを受けてインジェストジョブを開始する。"""
    client.start_ingestion_job(
        knowledgeBaseId=os.environ["KNOWLEDGE_BASE_ID"],
        dataSourceId=os.environ["DATA_SOURCE_ID"],
    )
