import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RegisterMachineDto } from './dto';
import { MachineView, MachinesService } from './machines.service';

@Controller('v1/machines')
@UseGuards(JwtAuthGuard)
export class MachinesController {
  constructor(private readonly machines: MachinesService) {}

  /** userId는 인증 세션에서 서버가 확정한다. 요청 본문의 userId를 받지 않는다 (CLAW-18). */
  @Post()
  @HttpCode(HttpStatus.OK)
  register(@Req() req: AuthenticatedRequest, @Body() dto: RegisterMachineDto): Promise<MachineView> {
    return this.machines.register(req.userId, dto.machineId);
  }

  @Get()
  list(@Req() req: AuthenticatedRequest): Promise<MachineView[]> {
    return this.machines.list(req.userId);
  }

  @Delete(':machineId')
  @HttpCode(HttpStatus.OK)
  release(@Req() req: AuthenticatedRequest, @Param('machineId') machineId: string): Promise<MachineView> {
    return this.machines.release(req.userId, machineId);
  }
}
