#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { BedrockKbS3VectorsRerankStack } from "../lib/bedrock-kb-s3vectors-rerank-stack";

const app = new cdk.App();

new BedrockKbS3VectorsRerankStack(app, "BedrockKbS3VectorsRerankStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1",
  },
});
