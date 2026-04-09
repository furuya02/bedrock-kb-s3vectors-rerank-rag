"""Bedrock Knowledge Base RAG Query Lambda with Reranking."""

import json
import os
from typing import Any

import boto3

KNOWLEDGE_BASE_ID = os.environ["KNOWLEDGE_BASE_ID"]
RERANK_MODEL_ID = os.environ.get("RERANK_MODEL_ID", "amazon.rerank-v1:0")
GENERATION_MODEL_ID = os.environ.get(
    "GENERATION_MODEL_ID", "anthropic.claude-3-5-sonnet-20241022-v2:0"
)
REGION = os.environ.get("REGION", "ap-northeast-1")

bedrock_agent_runtime = boto3.client(
    "bedrock-agent-runtime", region_name=REGION
)
bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION)


def retrieve_from_kb(
    query: str, top_k: int = 10
) -> list[dict[str, Any]]:
    """Knowledge Base からドキュメントを検索する。"""
    response = bedrock_agent_runtime.retrieve(
        knowledgeBaseId=KNOWLEDGE_BASE_ID,
        retrievalQuery={"text": query},
        retrievalConfiguration={
            "vectorSearchConfiguration": {
                "numberOfResults": top_k,
            }
        },
    )

    results = []
    for item in response.get("retrievalResults", []):
        results.append(
            {
                "content": item["content"]["text"],
                "score": item.get("score", 0.0),
                "location": item.get("location", {}),
                "metadata": item.get("metadata", {}),
            }
        )
    return results


def rerank_results(
    query: str,
    documents: list[dict[str, Any]],
    top_n: int = 5,
) -> list[dict[str, Any]]:
    """Amazon Rerank モデルでリランクする。"""
    if not documents:
        return []

    text_sources = [
        {
            "type": "INLINE",
            "inlineDocumentSource": {
                "type": "TEXT",
                "textDocument": {"text": doc["content"]},
            },
        }
        for doc in documents
    ]

    response = bedrock_agent_runtime.rerank(
        queries=[{"type": "TEXT", "textQuery": {"text": query}}],
        sources=text_sources,
        rerankingConfiguration={
            "type": "BEDROCK_RERANKING_MODEL",
            "bedrockRerankingConfiguration": {
                "modelConfiguration": {
                    "modelArn": f"arn:aws:bedrock:{REGION}::foundation-model/{RERANK_MODEL_ID}",
                },
                "numberOfResults": min(top_n, len(documents)),
            },
        },
    )

    reranked = []
    for result in response.get("results", []):
        idx = result["index"]
        reranked.append(
            {
                "content": documents[idx]["content"],
                "original_score": documents[idx]["score"],
                "rerank_score": result["relevanceScore"],
                "location": documents[idx]["location"],
            }
        )
    return reranked


def generate_response(query: str, contexts: list[dict[str, Any]]) -> str:
    """リランク済みコンテキストを使って回答を生成する。"""
    context_text = "\n\n---\n\n".join(
        [
            f"[Source {i + 1}] (relevance: {ctx['rerank_score']:.4f})\n{ctx['content']}"
            for i, ctx in enumerate(contexts)
        ]
    )

    prompt = f"""以下のコンテキスト情報を基に、ユーザーの質問に正確に回答してください。
コンテキストに含まれない情報については「情報が見つかりませんでした」と回答してください。

## コンテキスト
{context_text}

## 質問
{query}

## 回答"""

    body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 2048,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.0,
        }
    )

    response = bedrock_runtime.invoke_model(
        modelId=GENERATION_MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=body,
    )

    response_body = json.loads(response["body"].read())
    return response_body["content"][0]["text"]


def lambda_handler(
    event: dict[str, Any], context: Any
) -> dict[str, Any]:
    """Lambda ハンドラー。"""
    try:
        body = json.loads(event.get("body", "{}"))
        query = body.get("query", "")
        top_k = body.get("top_k", 10)
        top_n = body.get("top_n", 5)

        if not query:
            return {
                "statusCode": 400,
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps(
                    {"error": "query is required"}, ensure_ascii=False
                ),
            }

        # Step 1: Knowledge Base から検索
        retrieved_docs = retrieve_from_kb(query, top_k=top_k)

        # Step 2: リランクで関連度順に並び替え
        reranked_docs = rerank_results(query, retrieved_docs, top_n=top_n)

        # Step 3: リランク結果を基に回答生成
        answer = generate_response(query, reranked_docs)

        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(
                {
                    "answer": answer,
                    "sources": [
                        {
                            "content": doc["content"][:200] + "..."
                            if len(doc["content"]) > 200
                            else doc["content"],
                            "rerank_score": doc["rerank_score"],
                            "location": doc["location"],
                        }
                        for doc in reranked_docs
                    ],
                    "retrieved_count": len(retrieved_docs),
                    "reranked_count": len(reranked_docs),
                },
                ensure_ascii=False,
            ),
        }

    except Exception as e:
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(
                {"error": str(e)}, ensure_ascii=False
            ),
        }
