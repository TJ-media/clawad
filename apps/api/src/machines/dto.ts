import { IsString, Matches } from 'class-validator';

/**
 * machineId는 클라이언트가 crypto.randomBytes(16)으로 만든 32자리 소문자 hex다.
 * 형식을 강제해 MAC 주소·시리얼·하드웨어 UUID 같은 식별자가 흘러들어오지 못하게 막는다
 * (privacy-design.md §2, §6 — 구조로 차단).
 */
export const MACHINE_ID_PATTERN = /^[0-9a-f]{32}$/;

export class RegisterMachineDto {
  @IsString()
  @Matches(MACHINE_ID_PATTERN, {
    message: 'machineId는 32자리 소문자 hex여야 합니다(로컬 생성 가명값). 하드웨어 식별자를 보내지 마세요.',
  })
  machineId: string;
}
