declare module "solarlunar" {
  interface SolarLunarResult {
    lYear: number;
    lMonth: number;
    lDay: number;
    yearCn: string;
    monthCn: string;
    dayCn: string;
    cYear: number;
    cMonth: number;
    cDay: number;
    isLeap: boolean;
  }

  const solarLunar: {
    solar2lunar(year?: number, month?: number, day?: number): SolarLunarResult | -1;
    lunar2solar(
      year: number,
      month: number,
      day: number,
      isLeapMonth?: boolean,
    ): SolarLunarResult | -1;
  };

  export default solarLunar;
}
