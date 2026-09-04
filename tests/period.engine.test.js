const { calculatePeriodStatus, evaluateFIGOHealth } = require('../src/controllers/period.controller');

function localYMD(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

describe('Period Engine - Flo-Grade & FIGO Biorhythm', () => {
    test('1. Standard 28-day cycle test', () => {
        const today = new Date();
        const statusDay1 = calculatePeriodStatus(localYMD(today), 28, 5);
        expect(statusDay1.currentCycleDay).toBe(1);
        expect(statusDay1.phase).toBe('menstrual');
        expect(statusDay1.fertility).toBe('very_low');
        expect(statusDay1.ovulationDay).toBe(14);
    });

    test('2. 32-day cycle: Medical constant check', () => {
        const thirtyTwoDayStatus = calculatePeriodStatus(localYMD(new Date()), 32, 5);
        expect(thirtyTwoDayStatus.ovulationDay).toBe(18);
        expect(thirtyTwoDayStatus.fertileWindowStart).toBe(13);
        expect(thirtyTwoDayStatus.fertileWindowEnd).toBe(19);
    });

    test('3. 35-day cycle: Ovulation is 35 - 14 = 21', () => {
        const thirtyFiveDayStatus = calculatePeriodStatus(localYMD(new Date()), 35, 5);
        expect(thirtyFiveDayStatus.ovulationDay).toBe(21);
    });

    test('4. Overdue period test', () => {
        const overdueDate = new Date();
        overdueDate.setDate(overdueDate.getDate() - 35);
        const overdueStatus = calculatePeriodStatus(localYMD(overdueDate), 28, 5);
        expect(overdueStatus.phase).toBe('late');
        expect(overdueStatus.daysLate).toBe(7);
        expect(overdueStatus.currentCycleDay).toBe(36);
    });

    test('5. Ovulation day peak fertility test', () => {
        const ovDate = new Date();
        ovDate.setDate(ovDate.getDate() - 13);
        const ovStatus = calculatePeriodStatus(localYMD(ovDate), 28, 5);
        expect(ovStatus.currentCycleDay).toBe(14);
        expect(ovStatus.isOvulationToday).toBe(true);
        expect(ovStatus.fertility).toBe('peak');
        expect(ovStatus.fertilityChancePercent).toBe(30);
    });

    test('6. FIGO 2018: Normal healthy cycle assessment', () => {
        const assessment = evaluateFIGOHealth(28, 5, 'regular', []);
        expect(assessment.status).toBe('healthy');
        expect(assessment.riskFlags.length).toBe(0);
    });

    test('7. FIGO 2018: Polymenorrhea detection (< 24 days)', () => {
        const assessment = evaluateFIGOHealth(22, 5, 'regular', []);
        expect(assessment.status).toBe('needs_attention');
        expect(assessment.riskFlags.some(f => f.type === 'polymenorrhea')).toBe(true);
    });

    test('8. FIGO 2018: Oligomenorrhea detection (> 38 days)', () => {
        const assessment = evaluateFIGOHealth(40, 5, 'regular', []);
        expect(assessment.status).toBe('needs_attention');
        expect(assessment.riskFlags.some(f => f.type === 'oligomenorrhea')).toBe(true);
    });

    test('9. FIGO 2018: Menorrhagia detection (> 8 days flow)', () => {
        const assessment = evaluateFIGOHealth(28, 9, 'regular', []);
        expect(assessment.status).toBe('alert');
        expect(assessment.riskFlags.some(f => f.type === 'menorrhagia')).toBe(true);
    });
});

