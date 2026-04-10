"""Bedrock Knowledge Base RAG Query Lambda with Reranking."""

import json
import os

import boto3

KNOWLEDGE_BASE_ID = os.environ["KNOWLEDGE_BASE_ID"]
RERANK_MODEL_ID = os.environ.get("RERANK_MODEL_ID", "amazon.rerank-v1:0")
GENERATION_MODEL_ID = os.environ.get("GENERATION_MODEL_ID", "apac.anthropic.claude-3-5-sonnet-20241022-v2:0")
REGION = os.environ.get("REGION", "ap-northeast-1")

bedrock_agent = boto3.client("bedrock-agent-runtime", region_name=REGION)
bedrock = boto3.client("bedrock-runtime", region_name=REGION)


def lambda_handler(event, context):
    body = json.loads(event.get("body", "{}"))
    query = body.get("query", "")
    top_k = body.get("top_k", 10)
    top_n = body.get("top_n", 5)

    if not query:
        return response(400, {"error": "query is required"})

    try:
        # Step 1: Knowledge Base から検索
        docs = retrieve(query, top_k)

        # Step 2: リランクで関連度順に並び替え
        reranked = rerank(query, docs, top_n)

        # Step 3: リランク結果を基に回答生成
        answer = generate(query, reranked)

        return response(200, {
            "answer": answer,
            "sources": [
                {"content": d["content"][:200], "rerank_score": d["rerank_score"], "location": d["location"]}
                for d in reranked
            ],
            "retrieved_count": len(docs),
            "reranked_count": len(reranked),
        })
    except Exception as e:
        return response(500, {"error": str(e)})


def retrieve(query, top_k):
    res = bedrock_agent.retrieve(
        knowledgeBaseId=KNOWLEDGE_BASE_ID,
        retrievalQuery={"text": query},
        retrievalConfiguration={"vectorSearchConfiguration": {"numberOfResults": top_k}},
    )
    return [
        {"content": r["content"]["text"], "score": r.get("score", 0.0), "location": r.get("location", {})}
        for r in res.get("retrievalResults", [])
    ]


def rerank(query, docs, top_n):
    if not docs:
        return []

    res = bedrock_agent.rerank(
        queries=[{"type": "TEXT", "textQuery": {"text": query}}],
        sources=[
            {"type": "INLINE", "inlineDocumentSource": {"type": "TEXT", "textDocument": {"text": d["content"]}}}
            for d in docs
        ],
        rerankingConfiguration={
            "type": "BEDROCK_RERANKING_MODEL",
            "bedrockRerankingConfiguration": {
                "modelConfiguration": {"modelArn": f"arn:aws:bedrock:{REGION}::foundation-model/{RERANK_MODEL_ID}"},
                "numberOfResults": min(top_n, len(docs)),
            },
        },
    )
    return [
        {"content": docs[r["index"]]["content"], "rerank_score": r["relevanceScore"], "location": docs[r["index"]]["location"]}
        for r in res.get("results", [])
    ]


def generate(query, contexts):
    context_text = "\n\n---\n\n".join(
        f"[Source {i+1}] (relevance: {c['rerank_score']:.4f})\n{c['content']}" for i, c in enumerate(contexts)
    )
    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2048,
        "messages": [{"role": "user", "content": f"""以下のコンテキスト情報を基に、ユーザーの質問に正確に回答してください。
コンテキストに含まれない情報については「情報が見つかりませんでした」と回答してください。

## コンテキスト
{context_text}

## 質問
{query}

## 回答"""}],
        "temperature": 0.0,
    })
    res = bedrock.invoke_model(modelId=GENERATION_MODEL_ID, contentType="application/json", accept="application/json", body=body)
    return json.loads(res["body"].read())["content"][0]["text"]


def response(status_code, body):
    return {"statusCode": status_code, "headers": {"Content-Type": "application/json"}, "body": json.dumps(body, ensure_ascii=False)}
