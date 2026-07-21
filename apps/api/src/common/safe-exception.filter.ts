import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';

interface HttpResponse {
  headersSent?: boolean;
  status(code: number): { json(body: unknown): unknown };
  end(): unknown;
}

/**
 * 알 수 없는 예외의 query/parameters/stack을 Nest 기본 로거에 넘기지 않는다.
 * TypeORM 오류에는 토큰·사용자·기기 값이 포함될 수 있어 운영 로그에는 고정 코드만 남긴다.
 */
@Catch()
@Injectable()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();

    if (response.headersSent) {
      if (!(exception instanceof HttpException)) this.logger.error('UNHANDLED_REQUEST_EXCEPTION');
      response.end();
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const detail = exception.getResponse();
      const body = typeof detail === 'string' ? { statusCode: status, message: detail } : detail;
      response.status(status).json(body);
      return;
    }

    // 예외 객체나 request URL을 인자로 넘기지 않는다. 상세 원인은 민감정보 없는 별도 계측으로 진단한다.
    this.logger.error('UNHANDLED_REQUEST_EXCEPTION');
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
