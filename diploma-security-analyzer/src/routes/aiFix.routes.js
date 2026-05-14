const express = require('express');
const ctrl = require('../controllers/aiFix.controller');

const router = express.Router();

router.post('/issues/:issueId/generate-ai-fix', ctrl.generate);
router.get('/issues/:issueId/fixes', ctrl.list);
router.post('/fixes/:fixId/apply', ctrl.apply);

module.exports = router;
