const express = require('express');
const ctrl = require('../controllers/analysis.controller');

const router = express.Router();

router.post('/analyze', ctrl.analyze);
router.post('/analyze/openai', ctrl.analyzeWithOpenai);
router.get('/analyses', ctrl.listAnalyses);
router.get('/analyses/:analysisId', ctrl.getAnalysis);

module.exports = router;
