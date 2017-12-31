#!/usr/bin/python

import os, json

# Measure how long the script takes
from datetime import datetime
startTime = datetime.now()

JSON_OUTPUT = 'output.json'
# AWS parameters
ELB_NAME = 'itmo544-elb'
AVAILABILITY_ZONE = os.popen('aws configure get region').read().replace('\n', '')
AMI_ID = 'ami-78c1ee1d'
# Autoscaling parameters
AUTOSCALING_CONFIGURATION = 'itmo544-autoscaling-config'
AUTOSCALING_GROUP = 'itmo544-autoscaling-group'
# RDS values
RDS_ID = 'itmo544-rds-fgarciadelacorte'
# S3 bucket values
S3_BUCKET_NAME = 'itmo544-image-bucket-fgarciadelacorte'
# SNS values
SNS_TOPIC = 'itmo544-topic-fgarciadelacorte'

def execCommand(commandString):
	print('============================> Running command: ' + commandString + '\n')
	os.system(commandString)

def extractJSON():
	jsondict = {}
	with open(JSON_OUTPUT) as jsonfile:
		jsondict = json.load(jsonfile)
	os.remove(JSON_OUTPUT)
	return jsondict

# RDS 
execCommand('aws rds delete-db-instance'
			+ ' --db-instance-identifier ' + RDS_ID
			+ ' --skip-final-snapshot')

# RDS ReadOnly replica
execCommand('aws rds delete-db-instance'
			+ ' --db-instance-identifier read1-' + RDS_ID
			+ ' --skip-final-snapshot')

# S3 buckets (empty and remove)
execCommand('aws s3 rm s3://' + S3_BUCKET_NAME +' --recursive')
execCommand('aws s3api delete-bucket'
			+ ' --bucket ' + S3_BUCKET_NAME
			+ ' --region ' + AVAILABILITY_ZONE)
execCommand('aws s3 rm s3://post-' + S3_BUCKET_NAME +' --recursive')
execCommand('aws s3api delete-bucket'
			+ ' --bucket post-' + S3_BUCKET_NAME
			+ ' --region ' + AVAILABILITY_ZONE)
# ELB
execCommand('aws elb delete-load-balancer'
			+ ' --load-balancer-name ' + ELB_NAME)

# Autoscaling group (frontend)
execCommand('aws autoscaling delete-auto-scaling-group'
			+ ' --auto-scaling-group-name ' + AUTOSCALING_GROUP
			+ ' --force-delete')
execCommand('aws autoscaling delete-launch-configuration'
			+ ' --launch-configuration-name ' + AUTOSCALING_CONFIGURATION)

# Other EC2 instances
execCommand('aws ec2 describe-instances' 
			+ ' --filters Name=image-id,Values=' + AMI_ID
			+ ' > ' + JSON_OUTPUT)
ec2_instance_ids = [] # should be just one
for r in extractJSON()['Reservations']:
	ec2_instance_ids.append(r['Instances'][0]['InstanceId'])

execCommand('aws ec2 terminate-instances'
			+ ' --instance-ids ' + ' '.join(ec2_instance_ids))

# SQS
execCommand('aws sqs list-queues > ' + JSON_OUTPUT)
if (os.stat(JSON_OUTPUT).st_size > 0):
	for queueURL in extractJSON()['QueueUrls']:
		if 'itmo544-queue' in queueURL.split('/'):
			execCommand('aws sqs get-queue-url'
						+ ' --queue-name itmo544-queue'
						+ ' > ' + JSON_OUTPUT)
			execCommand('aws sqs delete-queue'
						+ ' --queue-url ' + queueURL)

# SNS - we delete the right topic, in case any other topics exist, and unsubscribe all
execCommand('aws sns list-topics > ' + JSON_OUTPUT)
if (os.stat(JSON_OUTPUT).st_size > 0):
	for topic in  extractJSON()['Topics']:
		if SNS_TOPIC in topic["TopicArn"].split(':'):
			execCommand('aws sns delete-topic'
						+ ' --topic-arn ' + topic["TopicArn"])
			break
execCommand('aws sns list-subscriptions > ' + JSON_OUTPUT)
if (os.stat(JSON_OUTPUT).st_size > 0):
	for sub in extractJSON()['Subscriptions']:
		if (sub['SubscriptionArn'] != 'PendingConfirmation'):
			execCommand('aws sns unsubscribe'
						+ ' --subscription-arn ' + sub['SubscriptionArn'])

######################## WAITERS ########################
# The RDS instances are the ones that take the longest to be terminated.
execCommand('aws rds wait db-instance-deleted'
			+ ' --db-instance-identifier ' + RDS_ID)

print('####################################################################################\n')
print('####################################################################################\n')
print('####################################################################################\n')
print('\n')

print('The scenario was succesfully destroyed.\n')
print('Execution time: ')
print(datetime.now() - startTime)