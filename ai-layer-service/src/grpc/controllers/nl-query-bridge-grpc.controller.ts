import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { NlAnalyticsBridgeService } from '../../ai/nl-analytics-bridge.service';
import { AnalyticsNlBridgeUnavailableError } from '../../ai/errors/analytics-nl-bridge-unavailable.error';
import { AnalyticsNlBridgeRateLimitedError } from '../../ai/errors/analytics-nl-bridge-rate-limited.error';
import { AnalyticsQuestionTooLongError } from '../../ai/errors/analytics-question-too-long.error';

interface TranslateQuestionRequest {
  tenantId: string;
  userId: string;
  question: string;
  availableMetricNames: string[];
}

interface TranslateQuestionResponse {
  errorCode: string;
  retryAfterSeconds: number;
  kind: string;
  metricName: string;
  filterJson: string;
  orgUnitId: string;
  period: string;
}

interface GenerateAnswerRequest {
  tenantId: string;
  userId: string;
  question: string;
  resultsJson: string;
}

interface GenerateAnswerResponse {
  errorCode: string;
  retryAfterSeconds: number;
  answerText: string;
}

/**
 * ADR-0165: Module 10's first inbound gRPC surface - see
 * nl_query_bridge.proto's own doc comment for why every failure mode comes
 * back as `error_code` on the response message rather than a thrown gRPC
 * status, same convention `ComplianceRuleGrpcController`'s `found: false`
 * sentinel already established for this platform's gRPC servers.
 */
@Controller()
export class NlQueryBridgeGrpcController {
  private readonly logger = new Logger(NlQueryBridgeGrpcController.name);

  constructor(private readonly bridge: NlAnalyticsBridgeService) {}

  @GrpcMethod('NlQueryBridgeService', 'TranslateQuestion')
  async translateQuestion(request: TranslateQuestionRequest): Promise<TranslateQuestionResponse> {
    try {
      const translated = await this.bridge.translateQuestion(
        request.tenantId,
        request.userId || null,
        request.question,
        request.availableMetricNames ?? [],
      );
      return {
        errorCode: '',
        retryAfterSeconds: 0,
        kind: translated.kind,
        metricName: translated.metricName ?? '',
        filterJson: '',
        orgUnitId: translated.orgUnitId ?? '',
        period: translated.period ?? '',
      };
    } catch (err) {
      return this.toTranslateErrorResponse(err);
    }
  }

  @GrpcMethod('NlQueryBridgeService', 'GenerateAnswer')
  async generateAnswer(request: GenerateAnswerRequest): Promise<GenerateAnswerResponse> {
    try {
      let results: unknown;
      try {
        results = JSON.parse(request.resultsJson);
      } catch {
        results = [];
      }
      const answerText = await this.bridge.generateAnswer(
        request.tenantId,
        request.userId || null,
        request.question,
        results,
      );
      return { errorCode: '', retryAfterSeconds: 0, answerText };
    } catch (err) {
      return { ...this.toRateLimitOrUnavailable(err), answerText: '' };
    }
  }

  private toTranslateErrorResponse(err: unknown): TranslateQuestionResponse {
    return {
      ...this.toRateLimitOrUnavailable(err),
      kind: '',
      metricName: '',
      filterJson: '',
      orgUnitId: '',
      period: '',
    };
  }

  private toRateLimitOrUnavailable(err: unknown): { errorCode: string; retryAfterSeconds: number } {
    if (err instanceof AnalyticsNlBridgeRateLimitedError) {
      return { errorCode: 'RATE_LIMITED', retryAfterSeconds: err.retryAfterSeconds };
    }
    if (err instanceof AnalyticsQuestionTooLongError) {
      return { errorCode: 'QUESTION_TOO_LONG', retryAfterSeconds: 0 };
    }
    if (err instanceof AnalyticsNlBridgeUnavailableError) {
      return { errorCode: 'UNAVAILABLE', retryAfterSeconds: 0 };
    }
    this.logger.error(`unexpected error in NlQueryBridgeService: ${(err as Error).message}`, (err as Error).stack);
    return { errorCode: 'UNAVAILABLE', retryAfterSeconds: 0 };
  }
}
