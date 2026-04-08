import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import { Construct } from "constructs";

export class BedrockKbS3VectorsRerankStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const region = this.region;
    const accountId = this.account;

    // ========================================
    // S3 Bucket: ドキュメントデータソース
    // ========================================
    const dataBucket = new s3.Bucket(this, "DataSourceBucket", {
      bucketName: `bedrock-kb-datasource-${accountId}-${region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // ========================================
    // S3 Vectors Bucket: ベクトルストア
    // ========================================
    const vectorsBucket = new s3.CfnBucket(this, "S3VectorsBucket", {
      bucketName: `bedrock-kb-s3vectors-${accountId}-${region}`,
    });
    vectorsBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ========================================
    // IAM Role: Bedrock Knowledge Base 用
    // ========================================
    const kbRole = new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      description: "Role for Bedrock Knowledge Base with S3 Vectors",
    });

    // データソース S3 へのアクセス権限
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [dataBucket.bucketArn, `${dataBucket.bucketArn}/*`],
      })
    );

    // S3 Vectors へのアクセス権限
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3vectors:CreateVectorBucket",
          "s3vectors:DeleteVectorBucket",
          "s3vectors:GetVectorBucket",
          "s3vectors:ListVectorBuckets",
          "s3vectors:CreateVectorIndex",
          "s3vectors:DeleteVectorIndex",
          "s3vectors:GetVectorIndex",
          "s3vectors:ListVectorIndexes",
          "s3vectors:PutVectors",
          "s3vectors:GetVectors",
          "s3vectors:DeleteVectors",
          "s3vectors:QueryVectors",
          "s3vectors:ListVectors",
        ],
        resources: [
          `arn:aws:s3vectors:${region}:${accountId}:vector-bucket/*`,
        ],
      })
    );

    // Bedrock Embedding モデルへのアクセス権限
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`,
        ],
      })
    );

    // ========================================
    // Bedrock Knowledge Base
    // ========================================
    const knowledgeBase = new bedrock.CfnKnowledgeBase(
      this,
      "KnowledgeBase",
      {
        name: "bedrock-kb-s3vectors-rerank",
        description:
          "Bedrock Knowledge Base with S3 Vectors and Reranking",
        roleArn: kbRole.roleArn,
        knowledgeBaseConfiguration: {
          type: "VECTOR",
          vectorKnowledgeBaseConfiguration: {
            embeddingModelArn: `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`,
            embeddingModelConfiguration: {
              bedrockEmbeddingModelConfiguration: {
                dimensions: 1024,
              },
            },
          },
        },
        storageConfiguration: {
          type: "S3_VECTORS",
          s3VectorsConfiguration: {
            vectorBucketArn: `arn:aws:s3vectors:${region}:${accountId}:vector-bucket/bedrock-kb-s3vectors-${accountId}-${region}`,
          },
        },
      }
    );

    knowledgeBase.node.addDependency(kbRole);

    // ========================================
    // Bedrock Data Source
    // ========================================
    const dataSource = new bedrock.CfnDataSource(this, "DataSource", {
      name: "s3-data-source",
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: {
          bucketArn: dataBucket.bucketArn,
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: "FIXED_SIZE",
          fixedSizeChunkingConfiguration: {
            maxTokens: 512,
            overlapPercentage: 20,
          },
        },
      },
    });

    // ========================================
    // Lambda: RAG クエリ（リランク付き）
    // ========================================
    const ragQueryLambda = new lambda.Function(this, "RagQueryFunction", {
      functionName: "bedrock-kb-rag-query",
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "handler.lambda_handler",
      code: lambda.Code.fromAsset("lambda/rag_query"),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        RERANK_MODEL_ID: "amazon.rerank-v1:0",
        GENERATION_MODEL_ID:
          "anthropic.claude-3-5-sonnet-20241022-v2:0",
        REGION: region,
      },
    });

    // Lambda に Bedrock へのアクセス権限を付与
    ragQueryLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:Retrieve",
          "bedrock:RetrieveAndGenerate",
          "bedrock:InvokeModel",
        ],
        resources: [
          knowledgeBase.attrKnowledgeBaseArn,
          `arn:aws:bedrock:${region}::foundation-model/amazon.rerank-v1:0`,
          `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0`,
        ],
      })
    );

    // ========================================
    // API Gateway
    // ========================================
    const api = new apigateway.RestApi(this, "RagApi", {
      restApiName: "Bedrock KB RAG API",
      description: "API for Bedrock Knowledge Base RAG with Reranking",
      deployOptions: {
        stageName: "v1",
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const queryResource = api.root.addResource("query");
    queryResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(ragQueryLambda)
    );

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, "KnowledgeBaseId", {
      value: knowledgeBase.attrKnowledgeBaseId,
      description: "Bedrock Knowledge Base ID",
    });

    new cdk.CfnOutput(this, "DataSourceBucketName", {
      value: dataBucket.bucketName,
      description: "S3 Data Source Bucket Name",
    });

    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: api.url,
      description: "API Gateway Endpoint URL",
    });

    new cdk.CfnOutput(this, "QueryEndpoint", {
      value: `${api.url}query`,
      description: "RAG Query Endpoint",
    });
  }
}
